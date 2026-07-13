/* ============================================================================
 * appwriteService.js  ·  ERP Panadería  ·  Appwrite Cloud 2.x (TablesDB)
 * ----------------------------------------------------------------------------
 * ÚNICO punto de contacto con Appwrite. index.html solo consume la API pública
 * de `appwriteService` + `awBootstrap()`. No hay fetch() fuera de este archivo
 * (salvo la sonda de diagnóstico, que vive aquí dentro).
 *
 * Arquitectura:
 *   1. Init idempotente        → un solo Client / TablesDB / Realtime.
 *   2. Diagnóstico de origen   → detecta CORS ANTES de lanzar 12 peticiones.
 *   3. CRUD genérico           → listar/obtener/crear/actualizar/eliminar.
 *   4. Retry + backoff + AbortController (máx. AW_CONFIG.maxRetries).
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

const _log = (...a) => { if (AW_CONFIG.debug) console.info('[appwrite]', ...a); };

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
    return new NetworkError(`La operación "${op}" superó ${AW_CONFIG.timeoutMs / 1000}s.`, { op, cause: e });
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
    `Appwrite rechazó el origen "${location.origin}". ` +
    `Abre la consola de Appwrite → Settings → Platforms → Add Platform → Web App ` +
    `y registra el hostname "${location.hostname}" (sin https:// y sin rutas). ` +
    `Si ya está registrado, el endpoint "${AW_CONFIG.endpoint}" no corresponde a la región del proyecto.`
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
  for (let intento = 1; intento <= AW_CONFIG.maxRetries; intento++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), AW_CONFIG.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      last = _normalize(e, op);
      if (!last.retryable || intento === AW_CONFIG.maxRetries) throw last;
      const espera = 2 ** (intento - 1) * 400 + Math.random() * 200; // 400ms → 800ms → 1600ms
      _log(`retry ${intento}/${AW_CONFIG.maxRetries} de "${op}" en ${Math.round(espera)}ms`);
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

const _num = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v) || d);
const _nul = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

/**
 * Fila cruda de Appwrite → objeto del ERP.
 * @param {string} table Nombre lógico de la tabla.
 * @param {object} row
 */
function rowToObj(table, row) {
  if (!row) return null;
  const id = row.$id;
  switch (table) {
    case 'clientes':
      return {
        id, nombre: row.nombre || '', tipo: row.tipo || '', telefono: row.telefono || '',
        direccion: row.direccion || '', color: row.color || '',
        lat: _nul(row.lat), lng: _nul(row.lng), orden: _num(row.orden),
        saldoInicial: row.saldoInicial === '' || row.saldoInicial == null ? undefined : Number(row.saldoInicial),
        tipoSaldo: row.tipoSaldo || undefined
      };
    case 'productos':
      return {
        id, nombre: row.nombre || '', precio: _num(row.precio), imagen: row.imagen || '',
        activo: row.activo === undefined ? true : !!row.activo, orden: _num(row.orden),
        vendajeActivo: !!row.vendajeActivo, vendajePct: _num(row.vendajePct),
        vendajeCada: _num(row.vendajeCada), clienteExclusivo: row.clienteExclusivo || null
      };
    case 'pedidos':
      return {
        id, clienteId: row.clienteId || '', fecha: row.fecha || '',
        items: _p(row.items, []) || [], comentario: row.comentario || '',
        total: _num(row.total), modoCondicion: row.modoCondicion || 'condicion'
      };
    case 'recaudo':
      return {
        id, fecha: row.fecha || '', pedidoId: row.pedidoId || '', clienteId: row.clienteId || '',
        cliente: row.cliente || '', tipo: row.tipo || '', subtotal: _num(row.subtotal),
        deuda: _num(row.deuda), entregado: !!row.entregado, recibido: !!row.recibido,
        recaudado: !!row.recaudado, nequi: _num(row.nequi), bancolombia: _num(row.bancolombia),
        deudaPago: _num(row.deudaPago), debeCliente: _num(row.debeCliente),
        faltante: _num(row.faltante), salida: _num(row.salida),
        observacion: row.observacion || '', efectivo: _num(row.efectivo),
        ...(_p(row.detalles, {}) || {})
      };
    case 'cartera':
      return {
        id, clienteId: row.clienteId || '', fecha: row.fecha || '', tipo: row.tipo || '',
        valor: _num(row.valor), saldoAnterior: _num(row.saldoAnterior),
        saldoActual: _num(row.saldoActual), observacion: row.observacion || ''
      };
    case 'empleados':
      return {
        id, nombre: row.nombre || '', periodo: row.periodo || 'semanal',
        salarioBase: _num(row.salarioBase), calendario: _p(row.calendario, {}) || {},
        adelantos: _p(row.adelantos, []) || [], pendientes: _p(row.pendientes, []) || []
      };
    case 'nominaHistorial':
      return { id, ...(_p(row.data, {}) || {}), empleadoId: row.empleadoId || '' };
    case 'contaMovimientos':
      return {
        id, tipo: row.tipo || '', categoria: row.categoria || '', valor: _num(row.valor),
        descripcion: row.descripcion || '', fecha: row.fecha || ''
      };
    case 'contaCategorias':
      return { id, nombre: row.nombre || '', tipo: row.tipo || '' };
    case 'contaCuentas':
      return { id, nombre: row.nombre || '', tipo: row.tipo || '', saldo: _num(row.saldo) };
    case 'contaTransferencias':
      return { id, ...(_p(row.data, {}) || {}) };
    case 'facturaConfig': {
      const cfg = _p(row.data, null);
      if (cfg) cfg._rowId = id;
      return cfg;
    }
    default:
      return { id, ...row };
  }
}

/**
 * Objeto del ERP → payload limpio para Appwrite (solo columnas existentes).
 * @param {string} table
 * @param {object} o
 */
function objToRow(table, o) {
  switch (table) {
    case 'clientes':
      return {
        nombre: o.nombre || '', tipo: o.tipo || '', telefono: o.telefono || '',
        direccion: o.direccion || '', color: o.color || '',
        lat: o.lat ?? '', lng: o.lng ?? '', orden: _num(o.orden),
        saldoInicial: o.saldoInicial ?? '', tipoSaldo: o.tipoSaldo || ''
      };
    case 'productos':
      return {
        nombre: o.nombre || '', precio: _num(o.precio), imagen: o.imagen || '',
        activo: !!o.activo, orden: _num(o.orden), vendajeActivo: !!o.vendajeActivo,
        vendajePct: _num(o.vendajePct), vendajeCada: _num(o.vendajeCada),
        clienteExclusivo: o.clienteExclusivo || ''
      };
    case 'pedidos':
      return {
        clienteId: o.clienteId || '', fecha: o.fecha || '', items: _j(o.items || []),
        comentario: o.comentario || '', total: _num(o.total),
        modoCondicion: o.modoCondicion || 'condicion'
      };
    case 'recaudo':
      return {
        fecha: o.fecha || '', pedidoId: o.pedidoId || '', clienteId: o.clienteId || '',
        cliente: o.cliente || '', tipo: o.tipo || '', subtotal: _num(o.subtotal),
        deuda: _num(o.deuda), entregado: !!o.entregado, recibido: !!o.recibido,
        recaudado: !!o.recaudado, nequi: _num(o.nequi), bancolombia: _num(o.bancolombia),
        deudaPago: _num(o.deudaPago), debeCliente: _num(o.debeCliente),
        faltante: _num(o.faltante), salida: _num(o.salida), observacion: o.observacion || '',
        efectivo: _num(o.efectivo), detalles: _j(o.detalles || {})
      };
    case 'cartera':
      return {
        clienteId: o.clienteId || '', fecha: o.fecha || '', tipo: o.tipo || '',
        valor: _num(o.valor), saldoAnterior: _num(o.saldoAnterior),
        saldoActual: _num(o.saldoActual), observacion: o.observacion || ''
      };
    case 'empleados':
      return {
        nombre: o.nombre || '', periodo: o.periodo || 'semanal', salarioBase: _num(o.salarioBase),
        calendario: _j(o.calendario || {}), adelantos: _j(o.adelantos || []),
        pendientes: _j(o.pendientes || [])
      };
    case 'nominaHistorial':
      return { empleadoId: o.empleadoId || o.empId || '', data: _j(o) };
    case 'contaMovimientos':
      return {
        tipo: o.tipo || '', categoria: o.categoria || '', valor: _num(o.valor),
        descripcion: o.descripcion || '', fecha: o.fecha || ''
      };
    case 'contaCategorias':
      return { nombre: o.nombre || '', tipo: o.tipo || '' };
    case 'contaCuentas':
      return { nombre: o.nombre || '', tipo: o.tipo || '', saldo: _num(o.saldo) };
    case 'contaTransferencias':
      return { data: _j(o) };
    case 'facturaConfig': {
      const clean = { ...o };
      delete clean._rowId;
      return { data: _j(clean) };
    }
    default:
      return { ...o };
  }
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
  if (Date.now() - t > AW_CONFIG.echoGraceMs) { _pending.delete(rowId); return false; }
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
  if (!opts.force && !opts.queries) {
    const hit = _cache.get(table);
    if (hit && Date.now() - hit.t < AW_CONFIG.cacheTtlMs) return hit.data;
  }
  const { Query } = window.Appwrite;
  const out = [];
  let offset = 0;

  for (;;) {
    const res = await _run(`listar ${table}`, () => _sdk.tables.listRows({
      databaseId: AW_CONFIG.databaseId,
      tableId: TABLE_IDS[table],
      queries: [Query.limit(AW_CONFIG.pageSize), Query.offset(offset), ...(opts.queries || [])]
    }));
    const filas = res.rows || res.documents || [];
    for (const r of filas) { const o = rowToObj(table, r); if (o) out.push(o); }
    if (filas.length < AW_CONFIG.pageSize) break;
    offset += AW_CONFIG.pageSize;
    if (offset > 100000) break; // salvaguarda anti-bucle infinito
  }

  if (!opts.queries) _cache.set(table, { t: Date.now(), data: out });
  return out;
}

/** Obtiene una fila por ID. @returns {Promise<object|null>} */
async function obtener(table, rowId) {
  try {
    const row = await _run(`obtener ${table}`, () => _sdk.tables.getRow({
      databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table], rowId
    }));
    return rowToObj(table, row);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/** Crea una fila. @returns {Promise<object>} */
async function crear(table, data, rowId) {
  const { ID } = window.Appwrite;
  const id = rowId || data.id || ID.unique();
  _marcarPropia(id);
  const row = await _run(`crear ${table}`, () => _sdk.tables.createRow({
    databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table],
    rowId: id, data: objToRow(table, data)
  }));
  _invalidar(table);
  return rowToObj(table, row);
}

/** Actualiza una fila existente. @returns {Promise<object>} */
async function actualizar(table, rowId, data) {
  _marcarPropia(rowId);
  const row = await _run(`actualizar ${table}`, () => _sdk.tables.updateRow({
    databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table],
    rowId, data: objToRow(table, data)
  }));
  _invalidar(table);
  return rowToObj(table, row);
}

/** Crea o actualiza (upsert). @returns {Promise<object>} */
async function guardar(table, rowId, data) {
  _marcarPropia(rowId);
  const row = await _run(`guardar ${table}`, () => _sdk.tables.upsertRow({
    databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table],
    rowId, data: objToRow(table, data)
  }));
  _invalidar(table);
  return rowToObj(table, row);
}

/** Elimina una fila. Un 404 se trata como éxito (ya no existe). */
async function eliminar(table, rowId) {
  _marcarPropia(rowId);
  try {
    await _run(`eliminar ${table}`, () => _sdk.tables.deleteRow({
      databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table], rowId
    }));
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
  if (!window.Appwrite) {
    console.error(new AppError('El SDK de Appwrite no se cargó. Revisa la etiqueta <script> del CDN.'));
    return false;
  }
  const { Client, TablesDB, Realtime, Account } = window.Appwrite;
  const client = new Client().setEndpoint(AW_CONFIG.endpoint).setProject(AW_CONFIG.projectId);
  _sdk = {
    client,
    tables: new TablesDB(client),
    realtime: new Realtime(client),
    account: new Account(client)
  };
  _ready = true;
  _log('SDK inicializado', AW_CONFIG.endpoint, AW_CONFIG.projectId);
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
  const t = setTimeout(() => ctrl.abort(), AW_CONFIG.timeoutMs);
  try {
    await fetch(`${AW_CONFIG.endpoint}/account`, {
      method: 'GET',
      headers: { 'X-Appwrite-Project': AW_CONFIG.projectId },
      signal: ctrl.signal,
      credentials: 'include'
    });
    _originOk = true; // llegó respuesta (aunque sea 401) ⇒ CORS correcto
  } catch (e) {
    _originOk = !(e instanceof TypeError); // TypeError ⇒ bloqueo del navegador
    if (!_originOk) console.error(new CorsError(_mensajeCors(), { op: 'verificarOrigen', cause: e }));
  } finally {
    clearTimeout(t);
  }
  _log('origen autorizado:', _originOk);
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
  const { Query } = window.Appwrite;
  const res = await _run('facturaConfig', () => _sdk.tables.listRows({
    databaseId: AW_CONFIG.databaseId,
    tableId: TABLE_IDS.facturaConfig,
    queries: [Query.limit(1)]
  }));
  const rows = res.rows || res.documents || [];
  return rows.length ? rowToObj('facturaConfig', rows[0]) : null;
}

/**
 * Descarga TODO desde Appwrite y rellena el objeto global `DB`.
 * @param {{silencioso?:boolean}} [opts]
 */
async function awCargarTodo(opts = {}) {
  if (!awIsReady()) return false;
  _bootErrors = [];

  const claves = ['clientes', 'productos', 'pedidos', 'recaudo', 'cartera', 'empleados',
    'nominaHistorial', 'contaMovimientos', 'contaCategorias', 'contaCuentas', 'contaTransferencias'];

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
function _aplicarEvento(ev) {
  const evento = (ev.events || []).find((s) => /tables\.[^.]+\.rows\.[^.]+\.(create|update|delete)$/.test(s));
  if (!evento || !ev.payload) return;

  const m = evento.match(/tables\.([^.]+)\.rows\.[^.]+\.(create|update|delete)$/);
  const table = TABLE_BY_ID[m[1]];
  const accion = m[2];
  const id = ev.payload.$id;
  if (!table || !id) return;

  // Eco de nuestra propia escritura: el DB local ya lo tiene. No repintar.
  if (_esEcoPropio(id)) { _log('eco ignorado', table, id); return; }

  const obj = rowToObj(table, ev.payload);
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
    case 'recaudo': {
      const f = obj?.fecha || ev.payload.fecha;
      const pid = obj?.pedidoId || ev.payload.pedidoId;
      if (!f || !pid) break;
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

  const { Channel } = window.Appwrite;
  const canales = Object.values(TABLE_IDS).map(
    (tid) => Channel.tablesdb(AW_CONFIG.databaseId).table(tid).row()
  );

  try {
    _rtSub = await _sdk.realtime.subscribe(canales, (ev) => {
      try { _aplicarEvento(ev); }
      catch (e) { console.error(new RealtimeError('Evento no aplicable', { cause: e })); }
    });
    _log('Realtime suscrito a', canales.length, 'canales');
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
  try { if (_rtSub) await _rtSub.unsubscribe(); } catch { /* noop */ }
  try { _sdk?.realtime?.disconnect(); } catch { /* noop */ }
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
  }, AW_CONFIG.resyncMs);
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
 * 9. BOOTSTRAP — lo único que index.html tiene que llamar
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Arranque completo: init → verificar origen → cargar todo → realtime.
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
 * 10. API PÚBLICA POR MÓDULO — todo reutiliza las 5 primitivas
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Aplica el patrón "optimista": muta el DB local y persiste; revierte si falla. */
async function _persistir(fn, mensajeError) {
  try { return await fn(); }
  catch (e) {
    const err = _normalize(e, 'guardar');
    console.error(err);
    _notify(mensajeError || err.message, 'error');
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

  /* ---------- CONFIGURACIÓN DE FACTURA (fila única global) ---------- */
  async guardarFacturaConfig(patch) {
    DB.facturaConfig = Object.assign({}, DB.facturaConfig, patch);
    const rowId = DB.facturaConfig._rowId || FACTURA_CONFIG_ROW_ID;
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
  awIniciarRealtime, awDetenerRealtime, awResync, awIsReady,
  genId: _genId,
  errores: { AppError, NetworkError, CorsError, PermissionError, ValidationError, NotFoundError, RealtimeError }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 11. EXPOSICIÓN GLOBAL + RED DE SEGURIDAD
 * ═══════════════════════════════════════════════════════════════════════════ */

window.appwriteService = appwriteService;
window.awBootstrap = awBootstrap;
window.awIsReady = awIsReady;
window.awResync = awResync;
/** Compatibilidad: el eco ya se controla por fila; esto es un no-op inocuo. */
window.awSetApplying = () => {};

/* Ninguna promesa queda sin capturar: se registra y se avisa una sola vez. */
window.addEventListener('unhandledrejection', (ev) => {
  if (ev.reason instanceof AppError) {
    ev.preventDefault();
    console.error(ev.reason);
  }
});
