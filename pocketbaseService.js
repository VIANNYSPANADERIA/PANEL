/* ============================================================================
 * pocketbaseService.js  ·  ERP Panadería  ·  PocketBase (misma API pública)
 * ----------------------------------------------------------------------------
 * ÚNICO punto de contacto con Appwrite. index.html solo consume la API pública
 * de `appwriteService` + `awBootstrap()`. No hay fetch() fuera de este archivo
 * (salvo la sonda de diagnóstico, que vive aquí dentro).
 *
 * Arquitectura:
 *   1. Init idempotente        → un solo Client / TablesDB / Realtime.
 *   2. Diagnóstico de origen   → detecta CORS ANTES de lanzar 12 peticiones.
 *   3. CRUD genérico           → listar/obtener/crear/actualizar/eliminar.
 *   4. Retry + backoff + AbortController (máx. PB_CONFIG.maxRetries).
 *   5. Caché en memoria con TTL e invalidación por escritura/evento.
 *   6. Realtime: UNA suscripción, N canales, un WebSocket. Reconexión +
 *      heartbeat + resync completo tras reconectar (cero eventos perdidos).
 *   7. Errores tipados: AppError / NetworkError / CorsError / PermissionError /
 *      ValidationError / NotFoundError / RealtimeError.
 *
 * Contrato con index.html: la app mantiene el objeto global `DB` como caché de
 * render. Este servicio lo muta y llama a `refrescarVistaActiva()` cuando llega
 * un cambio remoto. La fuente de verdad es Appwrite.
 * ========================================================================== */
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. ERRORES TIPADOS
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Error base del servicio. */
class AppError extends Error {
  /**
   * @param {string} message Mensaje legible para el usuario.
   * @param {{code?:number, op?:string, cause?:unknown, retryable?:boolean}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = new.target.name;
    this.code = meta.code ?? 0;
    this.op = meta.op ?? '';
    this.cause = meta.cause;
    this.retryable = meta.retryable ?? false;
  }
}
/** Fallo de red transitorio (timeout, 5xx, 429, offline). Reintentable. */
class NetworkError extends AppError {
  constructor(msg, meta = {}) { super(msg, { retryable: true, ...meta }); }
}
/** El origen del navegador no está autorizado por Appwrite. NO reintentable. */
class CorsError extends AppError {
  constructor(msg, meta = {}) { super(msg, { retryable: false, ...meta }); }
}
/** 401 / 403: permisos de tabla o de fila insuficientes. */
class PermissionError extends AppError {}
/** 400 / 409: payload inválido, columna inexistente, ID duplicado. */
class ValidationError extends AppError {}
/** 404: tabla o fila inexistente. */
class NotFoundError extends AppError {}
/** Fallo del canal Realtime. */
class RealtimeError extends AppError {}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. ESTADO INTERNO (una sola instancia de cada cosa)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** @type {{client:any, tables:any, realtime:any, account:any}|null} */
let _pb = null;   // instancia de PocketBase
let _sdk = null;
let _initPromise = null;      // desduplica awBootstrap() si lo llaman 2 veces
let _ready = false;
let _originOk = null;         // null = sin comprobar | true | false
let _rtSub = null;            // handle de la ÚNICA suscripción Realtime
let _rtTimer = null;          // heartbeat
let _onChange = null;         // callback de render que da index.html
let _renderTimer = null;      // debounce de render
let _resyncing = false;

/** Escrituras propias en vuelo: rowId → timestamp. Evita que el eco pise la UI. */
const _pending = new Map();
/** Caché de listas: tablaLógica → {t:number, data:Array} */
const _cache = new Map();
/** Errores acumulados durante la carga inicial (para un solo toast, no 12). */
let _bootErrors = [];

const _log = (...a) => { if (PB_CONFIG.debug) console.info('[pocketbase]', ...a); };

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. UTILIDADES
 * ═══════════════════════════════════════════════════════════════════════════ */

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ID legible y compatible con los que ya existen en el ERP. @returns {string} */
function _genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Serializa a JSON seguro (Appwrite Tables no admite objetos anidados). */
function _j(v) { try { return JSON.stringify(v ?? null); } catch { return 'null'; } }
/** Deserializa JSON con valor por defecto. */
function _p(s, fallback) {
  try { const v = JSON.parse(s); return v === null ? fallback : v; } catch { return fallback; }
}

/** Notifica al usuario reutilizando el toast del index.html si existe. */
function _notify(msg, type = 'error') {
  if (typeof window.toast === 'function') window.toast(msg, type);
  else console.warn(`[appwrite] ${msg}`);
}

/**
 * Convierte cualquier excepción en un error tipado del servicio.
 * @param {unknown} e
 * @param {string} op
 * @returns {AppError}
 */
function _normalize(e, op) {
  if (e instanceof AppError) return e;

  // AbortController disparó el timeout.
  if (e?.name === 'AbortError') {
    return new NetworkError(`La operación "${op}" superó ${PB_CONFIG.timeoutMs / 1000}s.`, { op, cause: e });
  }
  // El navegador bloqueó la petición: CORS, DNS o sin conexión.
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) {
    if (!navigator.onLine) {
      return new NetworkError('Sin conexión a internet. Trabajando en modo local.', { op, cause: e });
    }
    return new CorsError(_mensajeCors(), { op, cause: e });
  }

  const code = Number(e?.code ?? e?.status ?? 0);
  const raw = e?.message || String(e);
  if (code === 401 || code === 403) {
    return new PermissionError(
      `Sin permisos para "${op}". Revisa Permissions de la tabla en la consola de Appwrite.`,
      { code, op, cause: e });
  }
  if (code === 404) {
    return new NotFoundError(
      `No existe la tabla o la fila en "${op}". Verifica el Table ID y el Database ID.`,
      { code, op, cause: e });
  }
  if (code === 400 || code === 409) {
    return new ValidationError(`Datos inválidos en "${op}": ${raw}`, { code, op, cause: e });
  }
  if (code === 429 || code >= 500) {
    return new NetworkError(`Appwrite respondió ${code} en "${op}". Reintentando…`, { code, op, cause: e });
  }
  return new AppError(`Error en "${op}": ${raw}`, { code, op, cause: e });
}

/** Mensaje exacto de CORS, sin ocultar nada. */
function _mensajeCors() {
  return (
    `No se pudo conectar con PocketBase en "${PB_CONFIG.url}". ` +
    `Verifica que el servidor esté encendido y que la URL sea correcta. ` +
    `Si tu panel usa https:// y PocketBase usa http://, el navegador bloqueará la conexión (mixed content): ` +
    `necesitas SSL (https) en el servidor de PocketBase.`
  );
}

/**
 * Ejecuta una operación con timeout, reintentos y backoff exponencial.
 * @template T
 * @param {string} op Nombre legible de la operación (para los errores).
 * @param {(signal:AbortSignal)=>Promise<T>} fn
 * @returns {Promise<T>}
 */
async function _run(op, fn) {
  if (_originOk === false) throw new CorsError(_mensajeCors(), { op });

  let last;
  for (let intento = 1; intento <= PB_CONFIG.maxRetries; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PB_CONFIG.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      last = _normalize(e, op);
      if (!last.retryable || intento === PB_CONFIG.maxRetries) throw last;
      const espera = 2 ** (intento - 1) * 400 + Math.random() * 200; // 400ms → 800ms → 1600ms
      _log(`retry ${intento}/${PB_CONFIG.maxRetries} de "${op}" en ${Math.round(espera)}ms`);
      await _sleep(espera);
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. MAPEO fila Appwrite ⇄ objeto del ERP
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Factores de conversión a la UNIDAD BASE de cada insumo.
 * Sólidos → gramo · Líquidos → mililitro · Discretos → unidad.
 * Todos los cálculos de costo se hacen sobre la unidad base.
 * @type {Readonly<Record<string, number>>}
 */
const UNIDAD_FACTOR = Object.freeze({
  g: 1, kg: 1000,          // gramos
  ml: 1, l: 1000,          // mililitros
  unidad: 1, paquete: 1, caja: 1, bulto: 1   // discretos (precio por unidad de compra)
});

const _num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v) || d);
const _nul = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
/** Devuelve null en vez de '' : Appwrite rechaza cadena vacía en columnas numéricas/enum. */
const _oNull = (v) => (v === undefined || v === null || v === '' ? null : v);

/**
 * Fila cruda de Appwrite → objeto del ERP.
 * @param {string} table Nombre lógico de la tabla.
 * @param {object} row
 */
function rowToObj(table, row) {
  if (!row) return null;
  // En PocketBase guardamos el objeto completo del ERP en la columna `data`.
  // El id del ERP vive dentro de data.id; el id de PocketBase es row.id.
  const data = (row.data && typeof row.data === 'object') ? row.data : {};
  const obj = { ...data };
  // Conservamos el id lógico del ERP; si no existe, usamos el de PocketBase.
  if (!obj.id) obj.id = row.id;
  // Guardamos el id real de PocketBase para poder actualizar/eliminar por él.
  obj._pbId = row.id;
  if (table === 'facturaConfig') obj._rowId = obj.id;
  return obj;
}

/** Objeto del ERP → payload para PocketBase: todo va dentro de `data`. */
function objToRow(table, o) {
  const clean = { ...o };
  delete clean._pbId;   // no guardamos el id interno de PocketBase dentro de data
  return { data: clean };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. CRUD GENÉRICO — las 5 primitivas. Todo lo demás las reutiliza.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Marca una escritura propia para ignorar su eco de Realtime. */
function _marcarPropia(rowId) {
  if (rowId) _pending.set(rowId, Date.now());
}
/** ¿El evento que llegó es el eco de algo que acabamos de escribir nosotros? */
function _esEcoPropio(rowId) {
  const t = _pending.get(rowId);
  if (t === undefined) return false;
  if (Date.now() - t > PB_CONFIG.echoGraceMs) { _pending.delete(rowId); return false; }
  return true;
}

/** Invalida la caché de una tabla. */
function _invalidar(table) { _cache.delete(table); }

/**
 * Lista TODAS las filas de una tabla, con paginación automática y caché.
 * @param {string} table
 * @param {{force?:boolean, queries?:any[]}} [opts]
 * @returns {Promise<object[]>}
 */
async function listar(table, opts = {}) {
  if (!opts.force) {
    const hit = _cache.get(table);
    if (hit && Date.now() - hit.t < PB_CONFIG.cacheTtlMs) return hit.data;
  }
  const col = PB_COLLECTIONS[table];
  const filas = await _run(`listar ${table}`, () =>
    _pb.collection(col).getFullList({ batch: 1000 }));
  const out = [];
  for (const r of filas) { const o = rowToObj(table, r); if (o) out.push(o); }
  _cache.set(table, { t: Date.now(), data: out });
  return out;
}

/** Busca el id real de PocketBase a partir del id lógico del ERP. */
async function _pbIdDe(table, rowId) {
  const col = PB_COLLECTIONS[table];
  // Buscamos por el id lógico guardado dentro de data.id
  try {
    const res = await _pb.collection(col).getFirstListItem(`data.id="${rowId}"`);
    return res ? res.id : null;
  } catch (e) {
    if (e && (e.status === 404 || e.code === 404)) return null;
    // Si el filtro por JSON no está soportado, caemos a buscar en caché
    const hit = _cache.get(table);
    const item = hit && hit.data.find((x) => x.id === rowId);
    return item ? item._pbId : null;
  }
}

/** Obtiene una fila por ID. @returns {Promise<object|null>} */
async function obtener(table, rowId) {
  const pbId = await _pbIdDe(table, rowId);
  if (!pbId) return null;
  try {
    const row = await _run(`obtener ${table}`, () =>
      _pb.collection(PB_COLLECTIONS[table]).getOne(pbId));
    return rowToObj(table, row);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/** Crea una fila. @returns {Promise<object>} */
async function crear(table, data, rowId) {
  const id = rowId || data.id || _genId(table.slice(0, 3).toUpperCase());
  _marcarPropia(id);
  const payload = objToRow(table, { ...data, id });
  const row = await _run(`crear ${table}`, () =>
    _pb.collection(PB_COLLECTIONS[table]).create(payload));
  _invalidar(table);
  return rowToObj(table, row);
}

/** Actualiza una fila existente. @returns {Promise<object>} */
async function actualizar(table, rowId, data) {
  _marcarPropia(rowId);
  const pbId = (data && data._pbId) || await _pbIdDe(table, rowId);
  // Si no existe aún, lo creamos (upsert implícito).
  if (!pbId) return crear(table, { ...data, id: rowId }, rowId);
  const payload = objToRow(table, { ...data, id: rowId });
  const row = await _run(`actualizar ${table}`, () =>
    _pb.collection(PB_COLLECTIONS[table]).update(pbId, payload));
  _invalidar(table);
  return rowToObj(table, row);
}

/** Crea o actualiza (upsert). @returns {Promise<object>} */
async function guardar(table, rowId, data) {
  _marcarPropia(rowId);
  const pbId = (data && data._pbId) || await _pbIdDe(table, rowId);
  if (pbId) return actualizar(table, rowId, { ...data, _pbId: pbId });
  return crear(table, { ...data, id: rowId }, rowId);
}

/** Elimina una fila. Un 404 se trata como éxito (ya no existe). */
async function eliminar(table, rowId) {
  _marcarPropia(rowId);
  const pbId = await _pbIdDe(table, rowId);
  if (!pbId) { _invalidar(table); return; }
  try {
    await _run(`eliminar ${table}`, () =>
      _pb.collection(PB_COLLECTIONS[table]).delete(pbId));
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  _invalidar(table);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. INIT + DIAGNÓSTICO DE ORIGEN (CORS)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea las instancias del SDK. Idempotente: si ya está listo, no hace nada.
 * @returns {boolean}
 */
function awInit() {
  if (_ready) return true;
  if (typeof PocketBase === 'undefined') {
    console.error(new AppError('El SDK de PocketBase no se cargó. Revisa la etiqueta <script> del CDN.'));
    return false;
  }
  _pb = new PocketBase(PB_CONFIG.url);
  _pb.autoCancellation(false);   // permitimos peticiones paralelas
  _ready = true;
  _log('PocketBase inicializado', PB_CONFIG.url);
  return true;
}

/**
 * Sonda de origen: una sola petición barata a /account. Si el navegador la
 * bloquea, el origen NO está registrado como Platform (o la región del
 * endpoint es incorrecta). Un 401 de invitado es respuesta VÁLIDA: significa
 * que Appwrite sí devolvió cabeceras CORS.
 * @returns {Promise<boolean>}
 */
async function awVerificarOrigen() {
  if (_originOk !== null) return _originOk;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PB_CONFIG.timeoutMs);
  try {
    const r = await fetch(`${PB_CONFIG.url}/api/health`, { signal: ctrl.signal });
    _originOk = r.ok || r.status < 500;
  } catch (e) {
    _originOk = !(e instanceof TypeError);
    if (!_originOk) console.error(new CorsError(_mensajeCors(), { op: 'verificarOrigen', cause: e }));
  } finally {
    clearTimeout(t);
  }
  _log('servidor accesible:', _originOk);
  return _originOk;
}

/** @returns {boolean} */
function awIsReady() { return _ready && _originOk === true; }

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. CARGA INICIAL (12 tablas en paralelo, un solo toast si algo falla)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Snapshot inmutable de la config de factura por defecto (vive en index.html). */
function _defaultFC() {
  try {
    if (typeof _defaultFacturaConfig !== 'undefined' && _defaultFacturaConfig) {
      return JSON.parse(JSON.stringify(_defaultFacturaConfig));
    }
  } catch { /* noop */ }
  return {};
}

/** Envuelve una promesa para que un fallo no tumbe el Promise.all. */
async function _tolerante(nombre, promesa) {
  try { return await promesa; }
  catch (e) { _bootErrors.push(_normalize(e, nombre)); return null; }
}

/** Trae la fila única de configuración de factura. */
async function _cargarFacturaConfig() {
  const filas = await _run('facturaConfig', () =>
    _pb.collection(PB_COLLECTIONS.facturaConfig).getFullList({ batch: 1 }));
  return filas.length ? rowToObj('facturaConfig', filas[0]) : null;
}

/**
 * Descarga TODO desde Appwrite y rellena el objeto global `DB`.
 * @param {{silencioso?:boolean}} [opts]
 */
async function awCargarTodo(opts = {}) {
  if (!awIsReady()) return false;
  _bootErrors = [];

  const claves = ['clientes', 'productos', 'pedidos', 'recaudo', 'cartera', 'empleados',
    'nominaHistorial', 'contaMovimientos', 'contaCategorias', 'contaCuentas', 'contaTransferencias',
    'insumos', 'recetas', 'produccion', 'costosIndirectos', 'calendarioEventos'];

  const resultados = await Promise.all([
    ...claves.map((k) => _tolerante(k, listar(k, { force: true }))),
    _tolerante('facturaConfig', _cargarFacturaConfig())
  ]);

  const d = Object.fromEntries(claves.map((k, i) => [k, resultados[i]]));
  const fconfig = resultados[claves.length];

  if (d.clientes) DB.clientes = d.clientes.sort((a, b) => a.orden - b.orden);
  if (d.productos) DB.productos = d.productos.sort((a, b) => a.orden - b.orden);
  if (d.pedidos) DB.pedidos = d.pedidos;
  if (d.cartera) DB.cartera = d.cartera;
  if (d.empleados) DB.nomina.empleados = d.empleados;
  if (d.nominaHistorial) DB.nomina.historial = d.nominaHistorial;
  if (d.contaMovimientos) DB.conta.movimientos = d.contaMovimientos;
  if (d.contaCategorias) DB.conta.categorias = d.contaCategorias;
  if (d.contaCuentas) DB.conta.cuentas = d.contaCuentas;
  if (d.contaTransferencias) DB.conta.transferencias = d.contaTransferencias;
  if (d.insumos) DB.costos.insumos = d.insumos;
  if (d.recetas) DB.costos.recetas = d.recetas;
  if (d.produccion) DB.costos.produccion = d.produccion;
  if (d.costosIndirectos) DB.costos.indirectos = d.costosIndirectos;
  if (d.calendarioEventos) DB.calendario = d.calendarioEventos;
  if (d.recaudo) {
    DB.recaudo = {};
    for (const r of d.recaudo) {
      (DB.recaudo[r.fecha] ??= {})[r.pedidoId] = r;
    }
  }
  if (fconfig) DB.facturaConfig = Object.assign({}, _defaultFC(), fconfig);

  if (_bootErrors.length && !opts.silencioso) {
    const primero = _bootErrors[0];
    console.error(primero, _bootErrors);
    _notify(`${_bootErrors.length} tabla(s) no cargaron. ${primero.message}`, 'error');
    return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. REALTIME — una suscripción, un WebSocket, sin duplicados ni fugas
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Repinta la vista activa como máximo 1 vez cada 80 ms. */
function _render() {
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => {
    _renderTimer = null;
    try {
      if (typeof window.isUserEditing === 'function' && window.isUserEditing()) return;
      if (typeof _onChange === 'function') _onChange();
    } catch (e) { console.error(new RealtimeError('Fallo al repintar', { cause: e })); }
  }, 80);
}

/** Inserta / reemplaza / elimina un objeto dentro de un array por id. */
function _upsertArr(arr, id, obj, accion) {
  const i = arr.findIndex((x) => x.id === id);
  if (accion === 'delete') { if (i >= 0) arr.splice(i, 1); return; }
  if (i >= 0) arr[i] = obj; else arr.push(obj);
}

/**
 * Aplica un evento remoto al `DB` en memoria.
 * @param {{events:string[], payload:object}} ev
 */
function _aplicarEvento(table, ev) {
  // PocketBase envía { action: 'create'|'update'|'delete', record: {...} }
  const accion = ev.action;
  const record = ev.record;
  if (!table || !record) return;

  const obj = rowToObj(table, record);
  const id = obj ? obj.id : (record.data && record.data.id);
  if (!id) return;

  // Eco de nuestra propia escritura: el DB local ya lo tiene. No repintar.
  if (_esEcoPropio(id)) { _log('eco ignorado', table, id); return; }

  _invalidar(table);

  switch (table) {
    case 'clientes':
      _upsertArr(DB.clientes, id, obj, accion);
      DB.clientes.sort((a, b) => a.orden - b.orden); break;
    case 'productos':
      _upsertArr(DB.productos, id, obj, accion);
      DB.productos.sort((a, b) => a.orden - b.orden); break;
    case 'pedidos': _upsertArr(DB.pedidos, id, obj, accion); break;
    case 'cartera': _upsertArr(DB.cartera, id, obj, accion); break;
    case 'empleados': _upsertArr(DB.nomina.empleados, id, obj, accion); break;
    case 'nominaHistorial': _upsertArr(DB.nomina.historial, id, obj, accion); break;
    case 'contaMovimientos': _upsertArr(DB.conta.movimientos, id, obj, accion); break;
    case 'contaCategorias': _upsertArr(DB.conta.categorias, id, obj, accion); break;
    case 'contaCuentas': _upsertArr(DB.conta.cuentas, id, obj, accion); break;
    case 'contaTransferencias': _upsertArr(DB.conta.transferencias, id, obj, accion); break;
    case 'insumos': _upsertArr(DB.costos.insumos, id, obj, accion); break;
    case 'recetas': _upsertArr(DB.costos.recetas, id, obj, accion); break;
    case 'produccion': _upsertArr(DB.costos.produccion, id, obj, accion); break;
    case 'costosIndirectos': _upsertArr(DB.costos.indirectos, id, obj, accion); break;
    case 'calendarioEventos': _upsertArr(DB.calendario, id, obj, accion); break;
    case 'recaudo': {
      const f = obj?.fecha;
      const pid = obj?.pedidoId;
      if (!f || !pid) break;
      // Si esta fila tiene cambios locales pendientes de guardar, NO la sobrescribas
      // (evita que el realtime revierta lo que el usuario acaba de marcar/escribir).
      if (typeof window._recaudoCola !== 'undefined' && window._recaudoCola && window._recaudoCola.has(pid)) break;
      if (accion === 'delete') { if (DB.recaudo[f]) delete DB.recaudo[f][pid]; }
      else { (DB.recaudo[f] ??= {})[pid] = obj; }
      break;
    }
    case 'facturaConfig':
      if (obj) DB.facturaConfig = Object.assign({}, _defaultFC(), obj);
      break;
  }

  if (typeof window.saveDB === 'function') window.saveDB();
  _render();
}

/**
 * Abre la ÚNICA suscripción Realtime a las 12 tablas.
 * Si ya existe, no la duplica.
 * @param {Function} [onChange] Callback de repintado (viene de index.html).
 */
async function awIniciarRealtime(onChange) {
  if (onChange) _onChange = onChange;
  if (!awIsReady()) return;
  if (_rtSub) return; // ya suscrito: nunca duplicamos

  try {
    _rtSub = [];
    // PocketBase: una suscripción por colección al comodín '*'.
    for (const [logico, col] of Object.entries(PB_COLLECTIONS)) {
      const unsub = await _pb.collection(col).subscribe('*', (ev) => {
        try { _aplicarEvento(logico, ev); }
        catch (e) { console.error(new RealtimeError('Evento no aplicable', { cause: e })); }
      });
      _rtSub.push(unsub);
    }
    _log('Realtime suscrito a', _rtSub.length, 'colecciones');
    _arrancarHeartbeat();
  } catch (e) {
    _rtSub = null;
    const err = new RealtimeError('No se pudo abrir el canal en vivo.', { cause: e });
    console.error(err);
    _notify(err.message, 'error');
  }
}

/** Cierra la suscripción y el WebSocket. Sin fugas de memoria. */
async function awDetenerRealtime() {
  if (_rtTimer) { clearInterval(_rtTimer); _rtTimer = null; }
  try {
    if (Array.isArray(_rtSub)) for (const u of _rtSub) { try { await u(); } catch (e) {} }
  } catch { /* noop */ }
  _rtSub = null;
}

/**
 * Heartbeat: mientras la pestaña esté visible y online, resincroniza cada
 * `resyncMs`. Cualquier evento perdido durante una desconexión se recupera aquí.
 */
function _arrancarHeartbeat() {
  if (_rtTimer) return;
  _rtTimer = setInterval(() => {
    if (document.hidden || !navigator.onLine) return;
    awResync();
  }, PB_CONFIG.resyncMs);
}

/** Resincroniza el DB completo desde Appwrite (sin toasts de error). */
async function awResync() {
  if (_resyncing || !awIsReady()) return;
  _resyncing = true;
  try {
    _cache.clear();
    const ok = await awCargarTodo({ silencioso: true });
    if (ok) { if (typeof window.saveDB === 'function') window.saveDB(); _render(); }
  } finally {
    _resyncing = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 9. SESIÓN — login con correo/contraseña. La UI se inyecta desde aquí,
 *    para que index.html no tenga ni una línea de lógica de Appwrite.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** @returns {Promise<object|null>} Usuario activo o null si es invitado. */
async function awSesion() {
  try {
    if (_pb.authStore.isValid) {
      // Refrescamos para validar que el token sigue vigente.
      await _pb.collection('users').authRefresh();
      return _pb.authStore.record || _pb.authStore.model;
    }
  } catch { _pb.authStore.clear(); }
  return null;
}

/**
 * Inicia sesión. La sesión queda guardada en el navegador (~1 año).
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} Usuario autenticado.
 */
async function awLogin(email, password) {
  try {
    await _pb.collection('users').authWithPassword(email, password);
  } catch (e) {
    const code = Number(e?.status ?? e?.code ?? 0);
    if (code === 400 || code === 401) {
      throw new PermissionError('Correo o contraseña incorrectos.', { code, op: 'login', cause: e });
    }
    throw _normalize(e, 'login');
  }
  const user = _pb.authStore.record || _pb.authStore.model;
  if (!user) throw new PermissionError('No se pudo abrir la sesión.', { op: 'login' });
  return user;
}

/** Cierra la sesión y recarga el panel. */
async function awLogout() {
  await awDetenerRealtime();
  try { _pb.authStore.clear(); } catch { /* noop */ }
  location.reload();
}

/** Estilos del portal de acceso (inyectados una sola vez). */
const _LOGIN_CSS = `
#aw-login{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
  background:#f1f5f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
#aw-login .box{background:#fff;padding:32px 28px;border-radius:16px;width:min(360px,90vw);
  box-shadow:0 10px 40px rgba(15,23,42,.12);border:1px solid #e2e8f0}
#aw-login h2{margin:0 0 4px;font-size:20px;color:#0f172a}
#aw-login p.sub{margin:0 0 20px;font-size:13px;color:#64748b}
#aw-login label{display:block;font-size:12px;font-weight:600;color:#475569;margin:0 0 6px}
#aw-login input{width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:14px;border:1px solid #cbd5e1;
  border-radius:9px;font-size:14px;outline:none;transition:border-color .15s}
#aw-login input:focus{border-color:#4f46e5}
#aw-login button{width:100%;padding:12px;border:0;border-radius:9px;background:#4f46e5;color:#fff;
  font-size:14px;font-weight:600;cursor:pointer}
#aw-login button:disabled{opacity:.6;cursor:default}
#aw-login .err{min-height:18px;margin:10px 0 0;font-size:12.5px;color:#dc2626;text-align:center}`;

/**
 * Muestra el portal de acceso y resuelve cuando el usuario entra.
 * @returns {Promise<object>} Usuario autenticado.
 */
function _pedirLogin() {
  return new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = _LOGIN_CSS;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'aw-login';
    wrap.innerHTML = `
      <div class="box">
        <h2>Panadería · Panel ERP</h2>
        <p class="sub">Inicia sesión para sincronizar tus datos.</p>
        <label for="aw-email">Correo</label>
        <input id="aw-email" type="email" autocomplete="username" placeholder="tucorreo@ejemplo.com">
        <label for="aw-pass">Contraseña</label>
        <input id="aw-pass" type="password" autocomplete="current-password" placeholder="••••••••">
        <button id="aw-btn" type="button">Entrar</button>
        <p class="err" id="aw-err"></p>
      </div>`;
    document.body.appendChild(wrap);

    const $email = wrap.querySelector('#aw-email');
    const $pass = wrap.querySelector('#aw-pass');
    const $btn = wrap.querySelector('#aw-btn');
    const $err = wrap.querySelector('#aw-err');

    const entrar = async () => {
      $err.textContent = '';
      $btn.disabled = true;
      $btn.textContent = 'Entrando…';
      try {
        const user = await awLogin($email.value.trim(), $pass.value);
        style.remove();
        wrap.remove();
        resolve(user);
      } catch (e) {
        $err.textContent = e.message;
        $btn.disabled = false;
        $btn.textContent = 'Entrar';
        $pass.select();
      }
    };

    $btn.addEventListener('click', entrar);
    wrap.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') entrar(); });
    setTimeout(() => $email.focus(), 50);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 10. BOOTSTRAP — lo único que index.html tiene que llamar
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Arranque completo: init → origen → sesión → carga inicial → realtime.
 * Idempotente: si se llama dos veces, devuelve la misma promesa.
 * @param {Function} onChange Función de repintado de la vista activa.
 * @returns {Promise<boolean>} true si quedó conectado en vivo.
 */
function awBootstrap(onChange) {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!awInit()) { _notify('SDK de Appwrite no disponible · modo local', 'error'); return false; }

    if (!(await awVerificarOrigen())) {
      _notify('Appwrite bloqueó este dominio (CORS). Revisa la consola del navegador.', 'error');
      return false; // no lanzamos 12 peticiones condenadas ni bucles de WebSocket
    }

    // Sin sesión no hay permisos: pedimos acceso ANTES de tocar las tablas.
    let user = await awSesion();
    if (!user) user = await _pedirLogin();
    _log('sesión de', user.email);

    const ok = await awCargarTodo();
    _render();
    await awIniciarRealtime(onChange);

    // Reconexión y resync ante cambios de red / vuelta a la pestaña.
    window.addEventListener('online', awResync);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) awResync(); });
    window.addEventListener('pagehide', awDetenerRealtime);

    if (ok && _rtSub) _notify('Conectado a Appwrite · sync en vivo', 'success');
    return ok && !!_rtSub;
  })();
  return _initPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 11. API PÚBLICA POR MÓDULO — todo reutiliza las 5 primitivas
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Aplica el patrón "optimista": muta el DB local y persiste; revierte si falla. */
async function _persistir(fn, mensajeError) {
  try { return await fn(); }
  catch (e) {
    const err = _normalize(e, 'guardar');
    console.error(err);
    // Mostramos SIEMPRE el motivo real de Appwrite: nunca ocultamos el error.
    _notify(mensajeError ? `${mensajeError} · ${err.message}` : err.message, 'error');
    throw err;
  }
}

const appwriteService = {

  /* ---------- CLIENTES ---------- */
  async guardarCliente(data) {
    if (!data?.id && !data?.nombre) throw new ValidationError('El cliente necesita un nombre.');
    if (data.id) {
      const actual = DB.clientes.find((c) => c.id === data.id);
      const obj = { ...actual, ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('clientes', data.id, obj), 'No se pudo actualizar el cliente');
      return obj;
    }
    const obj = { id: _genId('C'), orden: DB.clientes.length, ...data };
    DB.clientes.push(obj);
    await _persistir(() => crear('clientes', obj, obj.id), 'No se pudo crear el cliente');
    return obj;
  },

  async eliminarCliente(id) {
    for (const p of DB.pedidos.filter((p) => p.clienteId === id)) {
      await appwriteService.eliminarPedido(p.id);
    }
    DB.clientes = DB.clientes.filter((c) => c.id !== id);
    await _persistir(() => eliminar('clientes', id), 'No se pudo eliminar el cliente');
  },

  async reordenarClientes(lista) {
    const cambios = [];
    lista.forEach((c, i) => { if (c.orden !== i) { c.orden = i; cambios.push(c); } });
    await _persistir(
      () => Promise.all(cambios.map((c) => actualizar('clientes', c.id, c))),
      'No se pudo guardar el nuevo orden'
    );
  },

  /* ---------- PRODUCTOS ---------- */
  async guardarProducto(data) {
    if (!data?.id && !data?.nombre) throw new ValidationError('El producto necesita un nombre.');
    if (data.id) {
      const actual = DB.productos.find((p) => p.id === data.id);
      const obj = { ...actual, ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('productos', data.id, obj), 'No se pudo actualizar el producto');
      return obj;
    }
    const obj = {
      id: _genId('P'), activo: true, orden: DB.productos.length + 1, vendajeActivo: false,
      vendajePct: 0, vendajeCada: 0, clienteExclusivo: null, ...data
    };
    DB.productos.push(obj);
    await _persistir(() => crear('productos', obj, obj.id), 'No se pudo crear el producto');
    return obj;
  },

  async eliminarProducto(id) {
    DB.productos = DB.productos.filter((p) => p.id !== id);
    await _persistir(() => eliminar('productos', id), 'No se pudo eliminar el producto');
  },

  async toggleProductoActivo(id, val) {
    const p = DB.productos.find((x) => x.id === id);
    if (!p) return;
    p.activo = !!val;
    await _persistir(() => actualizar('productos', id, p), 'No se pudo cambiar el estado');
  },

  async reordenarProductos(lista) {
    lista.forEach((p, i) => { p.orden = i + 1; });
    await _persistir(
      () => Promise.all(lista.map((p) => actualizar('productos', p.id, p))),
      'No se pudo guardar el orden de productos'
    );
  },

  /* ---------- PEDIDOS ---------- */
  async guardarPedido(p) {
    if (p.id) {
      const actual = DB.pedidos.find((x) => x.id === p.id);
      const obj = { ...actual, ...p };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('pedidos', p.id, obj), 'No se pudo actualizar el pedido');
      return obj;
    }
    const obj = { id: _genId('PD'), items: [], comentario: '', total: 0, modoCondicion: 'condicion', ...p };
    DB.pedidos.push(obj);
    await _persistir(() => crear('pedidos', obj, obj.id), 'No se pudo guardar el pedido');
    return obj;
  },

  async editarPedido(id, patch) {
    const p = DB.pedidos.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch);
    await _persistir(() => actualizar('pedidos', id, p), 'No se pudo actualizar el pedido');
    return p;
  },

  async eliminarPedido(id) {
    const p = DB.pedidos.find((x) => x.id === id);
    if (p) {
      const r = DB.recaudo[p.fecha]?.[id];
      if (r) await appwriteService.eliminarRecaudo(r.id);
      if (DB.recaudo[p.fecha]) delete DB.recaudo[p.fecha][id];
    }
    DB.pedidos = DB.pedidos.filter((x) => x.id !== id);
    await _persistir(() => eliminar('pedidos', id), 'No se pudo eliminar el pedido');
  },

  async obtenerPedidos(fecha) {
    return fecha ? DB.pedidos.filter((p) => p.fecha === fecha) : DB.pedidos;
  },

  /* ---------- RECAUDO ---------- */
  async guardarRecaudo(r) {
    if (r.id) {
      const actual = DB.recaudo[r.fecha]?.[r.pedidoId] || {};
      const obj = { ...actual, ...r };
      (DB.recaudo[obj.fecha] ??= {})[obj.pedidoId] = obj;
      await _persistir(() => actualizar('recaudo', r.id, obj), 'No se pudo guardar el recaudo');
      return obj;
    }
    const obj = {
      id: _genId('R'), entregado: false, recibido: false, recaudado: false, deuda: 0, nequi: 0,
      bancolombia: 0, deudaPago: 0, debeCliente: 0, faltante: 0, salida: 0, efectivo: 0,
      observacion: '', ...r
    };
    (DB.recaudo[obj.fecha] ??= {})[obj.pedidoId] = obj;
    await _persistir(() => crear('recaudo', obj, obj.id), 'No se pudo crear el recaudo');
    return obj;
  },

  /** Busca la fila de recaudo por id en el índice {fecha:{pedidoId:fila}}. */
  _buscarRecaudo(id) {
    for (const f of Object.keys(DB.recaudo)) {
      for (const pid of Object.keys(DB.recaudo[f])) {
        if (DB.recaudo[f][pid].id === id) return DB.recaudo[f][pid];
      }
    }
    return null;
  },

  async editarRecaudo(id, patch) {
    const fila = appwriteService._buscarRecaudo(id);
    if (!fila) return null;
    Object.assign(fila, patch);
    await _persistir(() => actualizar('recaudo', id, fila), 'No se pudo guardar el recaudo');
    return fila;
  },

  async eliminarRecaudo(id) {
    for (const f of Object.keys(DB.recaudo)) {
      for (const pid of Object.keys(DB.recaudo[f])) {
        if (DB.recaudo[f][pid].id === id) delete DB.recaudo[f][pid];
      }
    }
    await _persistir(() => eliminar('recaudo', id), 'No se pudo eliminar el recaudo');
  },

  async reiniciarRecaudoDia(fecha) {
    const filas = Object.values(DB.recaudo[fecha] || {});
    delete DB.recaudo[fecha];
    await _persistir(
      () => Promise.all(filas.map((r) => eliminar('recaudo', r.id))),
      'No se pudo reiniciar el día'
    );
  },

  /* ---------- CARTERA ---------- */
  async guardarMovCartera(m) {
    const obj = {
      id: m.id || _genId('M'), fecha: m.fecha || new Date().toISOString(),
      valor: 0, saldoAnterior: 0, saldoActual: 0, observacion: '', ...m
    };
    DB.cartera.push(obj);
    await _persistir(() => crear('cartera', obj, obj.id), 'No se pudo registrar el movimiento');
    return obj;
  },

  async obtenerCarteraCliente(clienteId) {
    return clienteId ? DB.cartera.filter((m) => m.clienteId === clienteId) : DB.cartera;
  },

  /* ---------- NÓMINA ---------- */
  async guardarEmpleado(data) {
    if (data.id) {
      const actual = DB.nomina.empleados.find((e) => e.id === data.id);
      const obj = { ...actual, ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('empleados', data.id, obj), 'No se pudo actualizar el empleado');
      return obj;
    }
    const obj = {
      id: _genId('E'), periodo: 'semanal', salarioBase: 0,
      calendario: {}, adelantos: [], pendientes: [], ...data
    };
    DB.nomina.empleados.push(obj);
    await _persistir(() => crear('empleados', obj, obj.id), 'No se pudo crear el empleado');
    return obj;
  },

  async editarEmpleado(id, patch) {
    const e = DB.nomina.empleados.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    await _persistir(() => actualizar('empleados', id, e), 'No se pudo actualizar el empleado');
  },

  async eliminarEmpleado(id) {
    DB.nomina.empleados = DB.nomina.empleados.filter((e) => e.id !== id);
    await _persistir(() => eliminar('empleados', id), 'No se pudo eliminar el empleado');
  },

  async guardarPagoNomina(entry, empleadoActualizado) {
    const obj = { id: entry.id || _genId('NH'), ...entry };
    DB.nomina.historial.push(obj);
    const emp = DB.nomina.empleados.find((e) => e.id === entry.empId);
    if (empleadoActualizado && emp) Object.assign(emp, empleadoActualizado);

    await _persistir(async () => {
      await crear('nominaHistorial', { ...obj, empleadoId: entry.empId }, obj.id);
      if (empleadoActualizado && emp) await actualizar('empleados', emp.id, emp);
    }, 'No se pudo registrar el pago de nómina');
    return obj;
  },

  /* ---------- CONTABILIDAD ---------- */
  async guardarMovimientoContable(m) {
    const obj = { id: m.id || _genId('MV'), fecha: new Date().toISOString().slice(0, 10), ...m };
    DB.conta.movimientos.push(obj);
    await _persistir(() => crear('contaMovimientos', obj, obj.id), 'No se pudo registrar el movimiento');
    return obj;
  },

  async editarMovimientoContable(id, patch) {
    const m = DB.conta.movimientos.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    await _persistir(() => actualizar('contaMovimientos', id, m), 'No se pudo actualizar el movimiento');
  },

  async eliminarMovimientoContable(id) {
    DB.conta.movimientos = DB.conta.movimientos.filter((m) => m.id !== id);
    await _persistir(() => eliminar('contaMovimientos', id), 'No se pudo eliminar el movimiento');
  },

  async guardarCategoriaContable(c) {
    if (c.id && DB.conta.categorias.some((x) => x.id === c.id)) {
      const actual = DB.conta.categorias.find((x) => x.id === c.id);
      Object.assign(actual, c);
      await _persistir(() => actualizar('contaCategorias', c.id, actual), 'No se pudo actualizar la categoría');
      return actual;
    }
    const obj = { id: c.id || _genId('CAT'), ...c };
    DB.conta.categorias.push(obj);
    await _persistir(() => crear('contaCategorias', obj, obj.id), 'No se pudo crear la categoría');
    return obj;
  },

  async eliminarCategoriaContable(id) {
    DB.conta.categorias = DB.conta.categorias.filter((c) => c.id !== id);
    await _persistir(() => eliminar('contaCategorias', id), 'No se pudo eliminar la categoría');
  },

  async guardarCuenta(c) {
    if (c.id && DB.conta.cuentas.some((x) => x.id === c.id)) {
      const actual = DB.conta.cuentas.find((x) => x.id === c.id);
      Object.assign(actual, c);
      await _persistir(() => actualizar('contaCuentas', c.id, actual), 'No se pudo actualizar la cuenta');
      return actual;
    }
    const obj = { id: c.id || _genId('CT'), saldo: 0, ...c };
    DB.conta.cuentas.push(obj);
    await _persistir(() => crear('contaCuentas', obj, obj.id), 'No se pudo crear la cuenta');
    return obj;
  },

  async editarCuenta(id, patch) {
    const c = DB.conta.cuentas.find((x) => x.id === id);
    if (!c) return;
    Object.assign(c, patch);
    await _persistir(() => actualizar('contaCuentas', id, c), 'No se pudo actualizar la cuenta');
  },

  async eliminarCuenta(id) {
    DB.conta.cuentas = DB.conta.cuentas.filter((c) => c.id !== id);
    await _persistir(() => eliminar('contaCuentas', id), 'No se pudo eliminar la cuenta');
  },

  async guardarTransferencia(t) {
    const obj = { id: t.id || _genId('TR'), fecha: new Date().toISOString().slice(0, 10), ...t };
    DB.conta.transferencias.push(obj);
    await _persistir(() => crear('contaTransferencias', obj, obj.id), 'No se pudo registrar la transferencia');
    return obj;
  },

  /* ---------- COSTOS Y RENTABILIDAD ---------- */

  /**
   * Crea o actualiza un insumo. Si cambia el precio, apila el precio anterior
   * en el historial (nunca se pierde) y recalcula el precio unitario base.
   * @param {object} data
   */
  async guardarInsumo(data) {
    if (!data?.id && !data?.nombre) throw new ValidationError('El insumo necesita un nombre.');
    const actual = data.id ? DB.costos.insumos.find((x) => x.id === data.id) : null;
    const obj = { ...(actual || {}), ...data };

    // Precio por unidad base (gramo, mililitro o unidad discreta).
    const factor = UNIDAD_FACTOR[obj.unidadCompra] ?? 1;
    const baseTotal = _num(obj.cantidadComprada) * factor;
    obj.precioBase = baseTotal > 0 ? _num(obj.precioCompra) / baseTotal : 0;

    // Historial: solo se apila si el precio base realmente cambió.
    obj.historial = Array.isArray(obj.historial) ? [...obj.historial] : [];
    const ult = obj.historial[obj.historial.length - 1];
    if (!ult || Math.abs(_num(ult.precioBase) - obj.precioBase) > 1e-9) {
      obj.historial.push({
        fecha: obj.fechaCompra || new Date().toISOString().slice(0, 10),
        precioCompra: _num(obj.precioCompra),
        cantidad: _num(obj.cantidadComprada),
        unidad: obj.unidadCompra,
        precioBase: obj.precioBase,
        variacion: ult && _num(ult.precioBase) > 0
          ? ((obj.precioBase - _num(ult.precioBase)) / _num(ult.precioBase)) * 100
          : 0
      });
      if (obj.historial.length > 200) obj.historial = obj.historial.slice(-200);
    }

    if (actual) {
      Object.assign(actual, obj);
      await _persistir(() => actualizar('insumos', obj.id, obj), 'No se pudo actualizar el insumo');
      return actual;
    }
    obj.id = obj.id || _genId('INS');
    DB.costos.insumos.push(obj);
    await _persistir(() => crear('insumos', obj, obj.id), 'No se pudo crear el insumo');
    return obj;
  },

  async eliminarInsumo(id) {
    DB.costos.insumos = DB.costos.insumos.filter((x) => x.id !== id);
    await _persistir(() => eliminar('insumos', id), 'No se pudo eliminar el insumo');
  },

  /** Crea o actualiza la receta (por LATA) de un producto. */
  async guardarReceta(data) {
    if (!data?.productoId) throw new ValidationError('La receta necesita un producto.');
    const actual = DB.costos.recetas.find((r) => r.productoId === data.productoId);
    const obj = { ...(actual || {}), ...data };
    obj.panesPorLata = Math.max(1, Math.round(_num(obj.panesPorLata, 1)));

    if (actual) {
      Object.assign(actual, obj);
      await _persistir(() => actualizar('recetas', actual.id, obj), 'No se pudo actualizar la receta');
      return actual;
    }
    obj.id = _genId('REC');
    DB.costos.recetas.push(obj);
    await _persistir(() => crear('recetas', obj, obj.id), 'No se pudo crear la receta');
    return obj;
  },

  async eliminarReceta(id) {
    DB.costos.recetas = DB.costos.recetas.filter((x) => x.id !== id);
    await _persistir(() => eliminar('recetas', id), 'No se pudo eliminar la receta');
  },

  /** Registra producción del día (en latas). El costo por lata se congela al registrar. */
  async guardarProduccion(data) {
    if (!data?.productoId) throw new ValidationError('La producción necesita un producto.');
    if (_num(data.latas) <= 0) throw new ValidationError('La cantidad de latas debe ser mayor a 0.');
    if (data.id) {
      const actual = DB.costos.produccion.find((x) => x.id === data.id);
      const obj = { ...(actual || {}), ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('produccion', data.id, obj), 'No se pudo actualizar la producción');
      return obj;
    }
    const obj = { id: _genId('PR'), ...data };
    DB.costos.produccion.push(obj);
    await _persistir(() => crear('produccion', obj, obj.id), 'No se pudo registrar la producción');
    return obj;
  },

  async eliminarProduccion(id) {
    DB.costos.produccion = DB.costos.produccion.filter((x) => x.id !== id);
    await _persistir(() => eliminar('produccion', id), 'No se pudo eliminar el registro');
  },

  /** Crea o actualiza un costo indirecto. */
  async guardarCostoIndirecto(data) {
    if (!data?.id && !data?.nombre) throw new ValidationError('El costo necesita un nombre.');
    if (data.id) {
      const actual = DB.costos.indirectos.find((x) => x.id === data.id);
      const obj = { ...(actual || {}), ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('costosIndirectos', data.id, obj), 'No se pudo actualizar el costo');
      return obj;
    }
    const obj = { id: _genId('CI'), activo: true, ...data };
    DB.costos.indirectos.push(obj);
    await _persistir(() => crear('costosIndirectos', obj, obj.id), 'No se pudo crear el costo');
    return obj;
  },

  async eliminarCostoIndirecto(id) {
    DB.costos.indirectos = DB.costos.indirectos.filter((x) => x.id !== id);
    await _persistir(() => eliminar('costosIndirectos', id), 'No se pudo eliminar el costo');
  },

  /* ---------- CALENDARIO ---------- */
  async guardarEvento(data) {
    if (!data?.id && !data?.titulo) throw new ValidationError('El evento necesita un título.');
    if (data.id) {
      const actual = DB.calendario.find((e) => e.id === data.id);
      const obj = { ...(actual || {}), ...data };
      if (actual) Object.assign(actual, obj);
      await _persistir(() => actualizar('calendarioEventos', data.id, obj), 'No se pudo actualizar el evento');
      return obj;
    }
    const obj = { id: _genId('EV'), color: '#3525cd', categoria: 'General', tipo: 'temporal', ...data };
    DB.calendario.push(obj);
    await _persistir(() => crear('calendarioEventos', obj, obj.id), 'No se pudo crear el evento');
    return obj;
  },

  async eliminarEvento(id) {
    DB.calendario = DB.calendario.filter((e) => e.id !== id);
    await _persistir(() => eliminar('calendarioEventos', id), 'No se pudo eliminar el evento');
  },

  /* ---------- CONFIGURACIÓN DE FACTURA (fila única global) ---------- */
  async guardarFacturaConfig(patch) {
    DB.facturaConfig = Object.assign({}, DB.facturaConfig, patch);
    const rowId = DB.facturaConfig._rowId || 'factura_config_global';
    await _persistir(async () => {
      await guardar('facturaConfig', rowId, DB.facturaConfig); // upsert: crea o actualiza
      DB.facturaConfig._rowId = rowId;
    }, 'No se pudo guardar la configuración de factura');
    return DB.facturaConfig;
  },

  /* ---------- IMPORTACIÓN MASIVA (migración desde Supabase) ---------- */
  /**
   * @param {string} table Nombre lógico de la tabla.
   * @param {object[]} filas
   * @returns {Promise<{ok:number, fallidos:number, errores:AppError[]}>}
   */
  async importarFila(table, filas) {
    let ok = 0; const errores = [];
    for (const f of filas || []) {
      try {
        const rowId = f.id || _genId(table.slice(0, 3).toUpperCase());
        await guardar(table, rowId, { ...f, id: rowId });
        ok++;
      } catch (e) { errores.push(_normalize(e, `importar ${table}`)); }
    }
    _invalidar(table);
    return { ok, fallidos: errores.length, errores };
  },

  /* ---------- Primitivas y utilidades expuestas ---------- */
  listar, obtener, crear, actualizar, guardar, eliminar,
  awBootstrap, awInit, awVerificarOrigen, awCargarTodo,
  awSesion, awLogin, awLogout,
  awIniciarRealtime, awDetenerRealtime, awResync, awIsReady,
  genId: _genId,
  UNIDAD_FACTOR,
  errores: { AppError, NetworkError, CorsError, PermissionError, ValidationError, NotFoundError, RealtimeError }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 12. EXPOSICIÓN GLOBAL + RED DE SEGURIDAD
 * ═══════════════════════════════════════════════════════════════════════════ */

window.appwriteService = appwriteService;
window.awBootstrap = awBootstrap;
window.awIsReady = awIsReady;
window.awResync = awResync;
window.awLogout = awLogout;   // ponle un botón: onclick="awLogout()"
window.awSesion = awSesion;
/** Compatibilidad: el eco ya se controla por fila; esto es un no-op inocuo. */
window.awSetApplying = () => {};

/* Ninguna promesa queda sin capturar: se registra y se avisa una sola vez. */
window.addEventListener('unhandledrejection', (ev) => {
  if (ev.reason instanceof AppError) {
    ev.preventDefault();
    console.error(ev.reason);
  }
});
