/* ============================================================================
 * costos.js · Módulo "Costos, Punto de Equilibrio y Rentabilidad"
 * ----------------------------------------------------------------------------
 * Se carga DESPUÉS del script principal de index.html, por lo que reutiliza sus
 * helpers globales ($, money, num, todayKey, modal, closeModal, toast, saveDB,
 * setHeader, DB, ROUTES) y toda la persistencia vive en `appwriteService`
 * (pocketbaseService.js). Este archivo NO habla con PocketBase directamente.
 * Realtime: el servicio suscribe `insumos`, `recetas`, `categorias_masa`,
 * `produccion` y `costos_indirectos` y repinta la vista activa.
 *
 * MODELO DE COSTOS (arroba_v2 · registros nuevos)
 *   · Insumo → precioBase = precioCompra / cantidadCompradaEnUnidadBase
 *     (paquetes/cajas/bultos: × unidades que trae cada uno).
 *   · Categoría de masa → receta para `arrobasBase` arrobas (1, ½ u otra).
 *       costoRecetaBase    = Σ cantidad × precioBase
 *       costoMasaPorArroba = costoRecetaBase / arrobasBase
 *       bolitasPorArroba   = pepasPorArroba × bolitasPorPepa   (4 × 36 = 144)
 *       costoPorBolita     = costoMasaPorArroba / bolitasPorArroba
 *   · Tipo de pan (categoría + producto) → bolitasPorPan, panesPorLata opcional,
 *     adicionales/empaques por pan, por grupo de N panes, por arroba o por lote.
 *       costoMasaPorPan     = costoPorBolita × bolitasPorPan
 *       costoVariablePorPan = costoMasaPorPan + adicionales variables por pan
 *   · Producción: por cada tipo de pan se indica cuánto se hace en libras,
 *     arrobas, panes o latas y se convierte a bolitas (coBolitasDe):
 *       arrobas = libras / librasPorArroba · bolitas = arrobas × bolitasPorArroba
 *       panes → panes × bolitasPorPan · latas → latas × panesPorLata × bolitasPorPan
 *     La masa total del registro es la suma. Por pan: panes = floor(asignadas / bolitasPorPan),
 *     remanente = asignadas − panes × bolitasPorPan (se conserva y se costea).
 *     Cada registro congela parámetros, receta, precios y configuración.
 *
 * MODELO HISTÓRICO (lata_v1 · registros antiguos, solo lectura de cálculo)
 *   · Receta por LATA y producción en latas: panes = latas × panesPorLata.
 *     Se conserva su cálculo original y nunca se aplica a registros nuevos.
 *
 * RESULTADO DIARIO (se mantiene la lógica existente, no es contabilidad de
 * inventarios ni costo de ventas):
 *   utilidad = ventas cobradas del día − costo de la producción del día
 *              − costos indirectos prorrateados al día
 *   Los vendajes NO se restan: el total del pedido ya excluye lo regalado.
 *
 * PUNTO DE EQUILIBRIO (margen de contribución con la mezcla real del día):
 *   para cada producto vendido: unidades entregadas = cobradas + vendajes
 *   costo variable unitario = el de su producción del día; si no se produjo,
 *   el costeo vigente de su única categoría de masa (o su receta histórica).
 *   razónMC = (ventas − Σ unidades × costoVariable) / ventas
 *   PE ($)  = costos fijos del día / razónMC
 * ========================================================================== */
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
 * CONSTANTES
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Unidades de compra permitidas y su equivalencia en la unidad base. */
const CO_UNIDADES = [
  { v: 'g',       l: 'Gramos',      base: 'g'  },
  { v: 'kg',      l: 'Kilogramos',  base: 'g'  },
  { v: 'ml',      l: 'Mililitros',  base: 'ml' },
  { v: 'l',       l: 'Litros',      base: 'ml' },
  { v: 'unidad',  l: 'Unidad',      base: 'und' },
  { v: 'paquete', l: 'Paquete',     base: 'und' },
  { v: 'caja',    l: 'Caja',        base: 'und' },
  { v: 'bulto',   l: 'Bulto',       base: 'und' }
];
/** Factor de conversión a unidad base. Fuente única: el servicio. */
const CO_FACTOR = appwriteService.UNIDAD_FACTOR;
/** Unidades que contienen otras (paquete de 200 bolsas). Fuente única: el servicio. */
const CO_CONTENEDOR = appwriteService.UNIDADES_CONTENEDOR;
/** Parámetros de masa por defecto. Fuente única: el servicio. */
const CO_PARAM_DEF = appwriteService.PARAMETROS_MASA_DEFAULT;
const CO_MODELO = appwriteService.MODELO_COSTOS;

const CO_CAT_INSUMO = ['Harinas', 'Grasas', 'Azúcares', 'Lácteos', 'Levaduras', 'Huevos', 'Sal y aditivos', 'Rellenos', 'Empaques', 'Otros'];
const CO_CAT_INDIRECTO = ['Producción', 'Administración', 'Ventas', 'Transporte', 'Mantenimiento', 'Limpieza', 'Servicios públicos', 'Depreciaciones', 'Otros'];

/** Divisor para prorratear cualquier periodicidad a COSTO POR DÍA. */
const CO_DIAS = { diario: 1, semanal: 7, quincenal: 15, mensual: 30, anual: 365 };

const CO_COLORS = ['#8a5a1c', '#00897b', '#f9a825', '#e53935', '#8e24aa', '#1e88e5', '#43a047', '#fb8c00', '#6d4c41', '#546e7a'];

/** Bases de aplicación de adicionales/empaques. */
const CO_BASES_AD = {
  pan:    'Por pan',
  grupo:  'Por grupo de N panes',
  arroba: 'Por arroba',
  lote:   'Fijo por registro'
};
const CO_ESTADOS = {
  pendiente:  { t: 'Pendiente de reparto', c: 'badge-warn' },
  planificado: { t: 'Estimado (sin confirmar)', c: '' },
  confirmado: { t: 'Confirmado', c: 'badge-success' }
};

/* ═══════════════════════════════════════════════════════════════════════════
 * ESTADO DE LA VISTA
 * ═══════════════════════════════════════════════════════════════════════════ */

let _coTab = 'dashboard';
let _coFecha = todayKey();
let _coCharts = [];
let _coBusqueda = '';
/** Ingredientes en edición dentro del modal de receta antigua por lata. */
let _coRecetaBuf = [];
/** Categoría de masa en edición (copia de trabajo del modal). */
let _coCatBuf = null;
let _coCatAbierta = -1;
/** Registro de producción en edición: {nuevo, grupos:[{id, categoriaId, snapshot}]} (un grupo por masa). */
let _coProd = null;
/** Caché por render del costeo vigente por producto (lo usa el PE de 30+ días). */
let _coCacheVig = new Map();

/* ═══════════════════════════════════════════════════════════════════════════
 * MOTOR DE CÁLCULO — funciones puras, sin efectos secundarios
 * ═══════════════════════════════════════════════════════════════════════════ */

const coNum = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v) || d);
const coEsV2 = (o) => o?.modelo === CO_MODELO.ARROBA;
const EPS = 1e-9;

/** Número decimal escrito con coma o punto ("0,5", "1,25", "12.5"). NaN si no es número. */
function coDec(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Bolitas por pan: admite decimales (0,72) con 4 cifras. null si no es válido. */
function coLeerBpp(v) {
  const n = coDec(v);
  return n > 0 ? Math.round(n * 10000) / 10000 : null;
}

/** Escapa texto del usuario antes de insertarlo en HTML. */
const coEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Número con hasta `d` decimales, sin rellenar ceros. */
const coN = (v, d = 2) => Number(v || 0).toLocaleString('es-CO', { maximumFractionDigits: d });
const CO_INCOMPLETO = '<span class="badge badge-warn">Costeo incompleto</span>';
/** Dinero o "Costeo incompleto" cuando el valor no se pudo calcular (null). */
const coM = (v) => (v == null ? CO_INCOMPLETO : money(v));
/** Dinero con 2 decimales (costos unitarios pequeños). */
const coM2 = (v) => (v == null ? CO_INCOMPLETO : '$' + coN(v, 2));

/** Unidad base ('g' | 'ml' | 'und') de una unidad de compra. */
function coBaseDe(unidad) {
  return (CO_UNIDADES.find(u => u.v === unidad) || { base: 'g' }).base;
}

/** Etiqueta corta de la unidad base, para mostrar precios ("$/g"). */
function coBaseLabel(unidad) {
  const b = coBaseDe(unidad);
  return b === 'und' ? 'unidad' : b;
}

/** @returns {object|null} Insumo por id. */
const coInsumo = (id) => DB.costos.insumos.find(i => i.id === id) || null;
/** @returns {object|null} Receta ANTIGUA (por lata) de un producto. */
const coReceta = (productoId) => DB.costos.recetas.find(r => r.productoId === productoId && !coEsV2(r)) || null;
/** @returns {object[]} Categorías de masa. */
const coCategorias = () => DB.costos.categorias || (DB.costos.categorias = []);
const coCategoria = (id) => coCategorias().find(c => c.id === id) || null;
const coProducto = (id) => DB.productos.find(p => p.id === id) || null;

/** ¿El insumo se puede costear? Un paquete sin contenido declarado NO. */
function coEstadoInsumo(ins) {
  if (!ins) return { ok: false, motivo: 'insumo eliminado' };
  if (ins.esMezcla) {
    // El precio de una mezcla se recalcula SIEMPRE con los precios de hoy de sus
    // ingredientes; se deja en memoria para que el resto del módulo lo lea igual
    // que el de cualquier insumo.
    const m = coCosteoMezcla(ins);
    if (m.ok) { ins.precioBase = m.precioBase; ins.precioCompra = m.costoTotal; }
    return { ok: m.ok, motivo: m.motivo };
  }
  if (CO_CONTENEDOR.includes(ins.unidadCompra) && !(coNum(ins.contenidoPorUnidad) > 0)) {
    return { ok: false, motivo: `falta indicar cuántas unidades trae cada ${ins.unidadCompra}` };
  }
  if (!(coNum(ins.precioBase) > 0)) return { ok: false, motivo: 'sin precio de compra' };
  return { ok: true, motivo: '' };
}

/**
 * MEZCLA GENERAL: insumo propio (esMezcla) armado con otros insumos.
 *   componentes = [{insumoId, cantidad}]  (cantidad en unidad base del insumo)
 *   rendimiento = gramos de mezcla que salen de esas cantidades
 *   precioBase  = Σ cantidad × precioBase / rendimiento   ($ por gramo de mezcla)
 * Lo que sobra se usa en la siguiente tanda, así que a cada tipo de pan solo se
 * le cobran los gramos de mezcla que lleva. No se permiten mezclas dentro de mezclas.
 */
function coCosteoMezcla(m) {
  const rend = coNum(m?.rendimiento);
  const detalle = (m?.componentes || []).map(g => {
    const ins = coInsumo(g.insumoId);
    const st = ins && !ins.esMezcla ? coEstadoInsumo(ins) : { ok: false, motivo: ins ? 'no se permite una mezcla dentro de otra' : 'insumo eliminado' };
    const costo = st.ok ? coNum(g.cantidad) * coNum(ins.precioBase) : null;
    return { insumoId: g.insumoId, nombre: ins ? ins.nombre : '(insumo eliminado)',
      unidad: ins ? coBaseLabel(ins.unidadCompra) : '', cantidad: coNum(g.cantidad),
      precioBase: st.ok ? coNum(ins.precioBase) : null, costo, ok: st.ok, motivo: st.motivo };
  });
  const malos = detalle.filter(d => !d.ok);
  const costoTotal = detalle.reduce((a, d) => a + (d.costo || 0), 0);
  let motivo = '';
  if (!detalle.length) motivo = 'la mezcla no tiene ingredientes';
  else if (malos.length) motivo = `mezcla: ${malos[0].nombre} ${malos[0].motivo}`;
  else if (!(rend > 0)) motivo = 'falta cuántos gramos rinde la mezcla';
  const ok = !motivo;
  return { detalle, costoTotal, rendimiento: rend, ok, motivo, precioBase: ok ? costoTotal / rend : null };
}

/** Fotografía del precio vigente de un insumo (se congela en cada registro). */
function coFotoInsumo(insumoId) {
  const ins = coInsumo(insumoId);
  const st = coEstadoInsumo(ins);
  return {
    insumoId,
    nombre: ins ? ins.nombre : '(insumo eliminado)',
    unidad: ins ? coBaseLabel(ins.unidadCompra) : '',
    precioBase: st.ok ? coNum(ins.precioBase) : null,
    ok: st.ok,
    motivo: st.motivo
  };
}

/** Parámetros de masa con los valores por defecto para lo que falte. */
function coParams(p) {
  const out = {};
  for (const k of Object.keys(CO_PARAM_DEF)) out[k] = coNum(p?.[k]) > 0 ? coNum(p[k]) : CO_PARAM_DEF[k];
  return out;
}

/**
 * Convierte una cantidad de masa a todas sus equivalencias.
 * @param {number} cantidad
 * @param {'lb'|'arroba'} unidad
 */
function coConvertir(cantidad, unidad, params) {
  const p = coParams(params);
  const c = coNum(cantidad);
  const arrobas = unidad === 'lb' ? c / p.librasPorArroba : c;
  const bolitasPorArroba = p.pepasPorArroba * p.bolitasPorPepa;
  return {
    cantidad: c, unidad, arrobas,
    libras: arrobas * p.librasPorArroba,
    pesoRefKg: arrobas * p.kgRefPorArroba,
    pepas: arrobas * p.pepasPorArroba,
    bolitasPorArroba,
    bolitas: arrobas * bolitasPorArroba
  };
}

/**
 * Fotografía completa de una categoría con los precios de HOY. Es lo que se
 * congela en cada producción: cambios posteriores de receta, precio o
 * rendimiento no la alteran.
 */
function coSnapshotCategoria(cat) {
  const ad = (a) => ({
    ...coFotoInsumo(a.insumoId),
    cantidad: coNum(a.cantidad),
    base: a.base,
    grupo: a.base === 'grupo' ? Math.max(1, Math.round(coNum(a.grupo, 1))) : null,
    gramosPorUnidad: coNum(a.gramosPorUnidad) > 0 ? coNum(a.gramosPorUnidad) : null
  });
  return {
    categoriaId: cat.id || null,
    nombre: cat.nombre || '',
    tomadoEn: new Date().toISOString(),
    parametros: coParams(cat.parametros),
    arrobasBase: coNum(cat.arrobasBase),
    ingredientes: (cat.ingredientes || []).map(g => ({ ...coFotoInsumo(g.insumoId), cantidad: coNum(g.cantidad) })),
    adicionales: (cat.adicionales || []).map(ad),
    lineas: (cat.productos || []).map(l => {
      const prod = coProducto(l.productoId);
      return {
        lineaId: l.lineaId,
        productoId: l.productoId,
        nombre: prod ? prod.nombre : '(producto eliminado)',
        precioVenta: prod ? coNum(prod.precio) : null,
        bolitasPorPan: coNum(l.bolitasPorPan),
        panesPorLata: coNum(l.panesPorLata) > 0 ? coNum(l.panesPorLata) : null,
        adicionales: (l.adicionales || []).map(ad)
      };
    }),
    repartoPredeterminado: { ...(cat.repartoPredeterminado || {}) }
  };
}

/** Costeo de la receta base de una fotografía. Valores null = costeo incompleto. */
function coCosteoReceta(snap) {
  const p = coParams(snap.parametros);
  const bolitasPorArroba = p.pepasPorArroba * p.bolitasPorPepa;
  const ab = coNum(snap.arrobasBase);
  const motivos = [];
  let costo = 0;
  const detalle = (snap.ingredientes || []).map(g => {
    const c = g.ok ? g.cantidad * g.precioBase : null;
    if (g.ok) costo += c; else motivos.push(`${g.nombre}: ${g.motivo}`);
    return { ...g, costo: c, porArroba: ab > 0 ? g.cantidad / ab : null };
  });
  if (!detalle.length) motivos.push('la receta no tiene ingredientes');
  if (!(ab > 0)) motivos.push('falta la cantidad base de la receta (arrobas)');
  const completo = motivos.length === 0;
  const cpa = completo ? costo / ab : null;
  return {
    detalle, arrobasBase: ab, bolitasPorArroba, completo, motivos,
    costoRecetaBase: completo ? costo : null,
    costoMasaPorArroba: cpa,
    costoMasaMediaArroba: completo ? cpa / 2 : null,
    costoPorBolita: completo ? cpa / bolitasPorArroba : null
  };
}

/**
 * Costeo UNITARIO vigente de un tipo de pan (estimación, no producción).
 * Los adicionales "por grupo" se prorratean como grupo completo (N panes) y
 * los "fijos por registro" no se reparten por pan: se informan aparte.
 */
function coCosteoUnitario(snap, l, rc = coCosteoReceta(snap)) {
  const motivos = [...rc.motivos];
  const bpa = rc.bolitasPorArroba;
  const bpp = coNum(l.bolitasPorPan);
  if (!(bpp > 0)) motivos.push('faltan las bolitas por pan');
  const masa = rc.costoPorBolita != null && bpp > 0 ? rc.costoPorBolita * bpp : null;
  let adic = 0, fijoLote = 0, adOk = true, porGrupo = false;
  const detalle = [];
  const sumar = (a, origen) => {
    if (!a.ok) { adOk = false; motivos.push(`${a.nombre}: ${a.motivo}`); detalle.push({ ...a, origen, porPan: null }); return; }
    const pu = a.cantidad * a.precioBase;
    let porPan = null;
    if (a.base === 'pan') porPan = pu;
    else if (a.base === 'grupo') { porPan = pu / a.grupo; porGrupo = true; }
    else if (a.base === 'arroba') porPan = bpp > 0 ? pu * bpp / bpa : null;
    else fijoLote += pu;
    if (porPan != null) adic += porPan;
    detalle.push({ ...a, origen, porPan, porLote: a.base === 'lote' ? pu : null });
  };
  (l.adicionales || []).forEach(a => sumar(a, 'producto'));
  (snap.adicionales || []).forEach(a => sumar(a, 'categoría'));
  if (l.precioVenta == null) motivos.push('producto eliminado del catálogo');
  const completo = motivos.length === 0 && masa != null;
  const variable = completo ? masa + adic : null;
  const margen = completo ? l.precioVenta - variable : null;
  return {
    masaPorPan: masa,
    adicionalesPorPan: adOk ? adic : null,
    variablePorPan: variable,
    fijoPorLote: adOk ? fijoLote : null,
    porGrupo, detalle,
    panesPorArroba: bpp > 0 ? Math.floor(bpa / bpp + EPS) : null,
    precio: l.precioVenta,
    margen,
    margenPct: margen != null && l.precioVenta > 0 ? (margen / l.precioVenta) * 100 : null,
    completo, motivos
  };
}

/** Control de latas (solo horneado). null = sin configuración de latas. */
function coLatas(panes, panesPorLata) {
  const ppl = coNum(panesPorLata);
  if (!(ppl > 0)) return null;
  const completas = Math.floor(panes / ppl + EPS);
  const resto = panes - completas * ppl;
  return {
    panesPorLata: ppl,
    equivalentes: panes / ppl,
    necesarias: completas + (resto > EPS ? 1 : 0),
    completas,
    panesUltimaLata: resto > EPS ? resto : (completas > 0 ? ppl : 0)
  };
}

/**
 * Unidades de un adicional según su base. Regla de grupos:
 * bolsasNecesarias = cantidad × ceil(panes / N) — el redondeo se aplica a cada
 * tipo de pan dentro del registro, por eso el costo unitario depende del lote.
 */
function coUnidadesAdicional(a, panes, arrobas) {
  switch (a.base) {
    case 'pan': return a.cantidad * panes;
    case 'grupo': return a.cantidad * Math.ceil(panes / Math.max(1, a.grupo));
    case 'arroba': return a.cantidad * arrobas;
    default: return a.cantidad;   // 'lote': una vez por registro
  }
}

/**
 * Bolitas de masa que corresponden a lo que se mandó a hacer de un tipo de pan.
 * @param {'lb'|'arroba'|'panes'|'latas'} unidad
 */
function coBolitasDe(cantidad, unidad, linea, params) {
  const p = coParams(params);
  const bpa = p.pepasPorArroba * p.bolitasPorPepa;
  const c = coNum(cantidad);
  const bpp = coNum(linea.bolitasPorPan);
  switch (unidad) {
    case 'lb': return c / p.librasPorArroba * bpa;
    case 'arroba': return c * bpa;
    case 'panes': return c * bpp;
    case 'latas': return c * coNum(linea.panesPorLata) * bpp;
    default: return 0;
  }
}

/** Texto de la cantidad de un adicional: en gramos si se ingresó así, si no en su unidad base. */
function coAdCantTxt(a, unidades = a.cantidad) {
  return a.gramosPorUnidad
    ? `${coN(unidades * a.gramosPorUnidad, 2)} g <span class="muted">(${coN(unidades, 4)} ${a.unidad || 'und'})</span>`
    : `${coN(unidades, 4)} ${a.unidad || 'und'}`;
}

/**
 * Cálculo completo de un lote a partir de su fotografía. Función pura: con la
 * misma fotografía y las mismas entradas siempre da el mismo resultado.
 * @param {object} snap Fotografía de la categoría (coSnapshotCategoria).
 * @param {number} cantidad
 * @param {'lb'|'arroba'} unidad
 * @param {{lineaId:string, bolitasAsignadas:number, panesConfirmados?:number|null}[]} entradas
 * @param {{confirmado?:boolean}} [opts]
 */
function coCalcularLote(snap, cantidad, unidad, entradas, opts = {}) {
  const conv = coConvertir(cantidad, unidad, snap.parametros);
  const rc = coCosteoReceta(snap);
  const cpb = rc.costoPorBolita;
  const motivos = [...rc.motivos];
  const costoMasaLote = rc.completo ? rc.costoMasaPorArroba * conv.arrobas : null;

  const potenciales = (snap.lineas || []).map(l => {
    const bpp = coNum(l.bolitasPorPan);
    const panes = bpp > 0 ? Math.floor(conv.bolitas / bpp + EPS) : 0;
    return {
      lineaId: l.lineaId, productoId: l.productoId, nombre: l.nombre, bolitasPorPan: bpp,
      panesPosibles: panes,
      bolitasRemanentes: bpp > 0 ? Math.max(0, conv.bolitas - panes * bpp) : conv.bolitas,
      latas: coLatas(panes, l.panesPorLata)
    };
  });

  const mapa = new Map((entradas || []).map(e => [e.lineaId, e]));
  let asignadas = 0;
  const reparto = [];
  for (const l of snap.lineas || []) {
    const e = mapa.get(l.lineaId);
    const asig = Math.max(0, coNum(e?.bolitasAsignadas));
    if (!(asig > 0)) continue;
    const bpp = coNum(l.bolitasPorPan);
    if (!(bpp > 0)) { motivos.push(`${l.nombre}: faltan las bolitas por pan`); continue; }
    asignadas += asig;
    const panesEstimados = Math.floor(asig / bpp + EPS);
    const rem = Math.max(0, asig - panesEstimados * bpp);
    const conf = opts.confirmado && e.panesConfirmados !== undefined && e.panesConfirmados !== null && e.panesConfirmados !== ''
      ? Math.max(0, Math.round(coNum(e.panesConfirmados))) : null;
    const panesBase = conf ?? panesEstimados;
    const arrobasAsig = asig / conv.bolitasPorArroba;

    let adOk = true, costoAd = 0;
    const adicionales = (l.adicionales || []).map(a => {
      const unidades = (a.base === 'lote' && panesBase <= 0) ? 0 : coUnidadesAdicional(a, panesBase, arrobasAsig);
      if (!a.ok) { adOk = false; motivos.push(`${l.nombre} · ${a.nombre}: ${a.motivo}`); }
      const costo = a.ok ? unidades * a.precioBase : null;
      if (costo != null) costoAd += costo;
      return { ...a, unidades, costo };
    });

    reparto.push({
      lineaId: l.lineaId, productoId: l.productoId, nombre: l.nombre, precioVenta: l.precioVenta,
      bolitasPorPan: bpp, bolitasAsignadas: asig, arrobasAsignadas: arrobasAsig,
      panesEstimados, bolitasRemanentes: rem,
      panesConfirmados: conf, panesBase,
      costoMasa: cpb != null ? asig * cpb : null,
      costoMasaPanes: cpb != null ? panesEstimados * bpp * cpb : null,
      costoRemanente: cpb != null ? rem * cpb : null,
      adicionales, costoAdicionales: adOk ? costoAd : null,
      latas: coLatas(panesBase, l.panesPorLata)
    });
  }

  const excedido = asignadas > conv.bolitas + 1e-6;
  const bolitasSinAsignar = Math.max(0, conv.bolitas - asignadas);

  // Adicionales de la categoría: UNA vez por registro (no por producto).
  let adCatOk = true, costoAdCat = 0;
  const adicionalesCategoria = (snap.adicionales || []).map(a => {
    const unidades = a.base === 'arroba' ? a.cantidad * conv.arrobas : a.cantidad;
    if (!a.ok) { adCatOk = false; motivos.push(`${a.nombre}: ${a.motivo}`); }
    const costo = a.ok ? unidades * a.precioBase : null;
    if (costo != null) costoAdCat += costo;
    return { ...a, unidades, costo };
  });
  const costoAdicionalesCategoria = adCatOk ? costoAdCat : null;

  let adProdOk = true, costoAdProd = 0, panesEst = 0, panesConf = 0, rems = 0, latasEq = 0, lineasSinLatas = 0;
  for (const r of reparto) {
    // La parte de los adicionales de categoría se muestra por producto en
    // proporción a sus bolitas; el total se cobra una sola vez.
    r.costoAdCategoria = costoAdicionalesCategoria != null && conv.bolitas > 0
      ? costoAdicionalesCategoria * r.bolitasAsignadas / conv.bolitas : null;
    r.costoTotal = [r.costoMasa, r.costoAdicionales, r.costoAdCategoria].some(v => v == null)
      ? null : r.costoMasa + r.costoAdicionales + r.costoAdCategoria;
    r.costoPorPan = r.costoTotal != null && r.panesBase > 0 ? r.costoTotal / r.panesBase : null;
    if (r.costoAdicionales == null) adProdOk = false; else costoAdProd += r.costoAdicionales;
    panesEst += r.panesEstimados;
    panesConf += r.panesConfirmados ?? 0;
    rems += r.bolitasRemanentes;
    if (r.latas) latasEq += r.latas.equivalentes; else lineasSinLatas++;
  }

  const estado = asignadas <= 0 ? 'pendiente' : (opts.confirmado ? 'confirmado' : 'planificado');
  const costoAdicionalesProductos = adProdOk ? costoAdProd : null;
  const costoAdicionales = adProdOk && adCatOk ? costoAdProd + costoAdCat : null;
  const completo = motivos.length === 0;
  const costoTotalLote = completo && costoMasaLote != null && costoAdicionales != null
    ? costoMasaLote + costoAdicionales : null;

  return {
    ...conv,
    parametros: coParams(snap.parametros),
    arrobasBase: rc.arrobasBase,
    costoRecetaBase: rc.costoRecetaBase,
    costoMasaPorArroba: rc.costoMasaPorArroba,
    costoPorBolita: cpb,
    costoMasaLote,
    potenciales, reparto, estado, excedido,
    bolitasAsignadas: asignadas,
    bolitasSinAsignar,
    costoSinAsignar: cpb != null ? bolitasSinAsignar * cpb : null,
    bolitasRemanentes: rems,
    costoRemanentes: cpb != null ? rems * cpb : null,
    adicionalesCategoria, costoAdicionalesCategoria, costoAdicionalesProductos, costoAdicionales,
    costoTotalLote,
    panesEstimados: estado === 'pendiente' ? 0 : panesEst,
    panesConfirmados: estado === 'confirmado' ? panesConf : 0,
    latasEquivalentes: latasEq, lineasSinLatas,
    completo, motivos: [...new Set(motivos)]
  };
}

/** Resultado congelado de un registro nuevo (lo recalcula de su fotografía si faltara). */
function coResultadoDe(r) {
  if (r.resultado) return r.resultado;
  if (!r.snapshot) return null;
  return coCalcularLote(r.snapshot, r.cantidad, r.unidad, r.reparto, { confirmado: !!r.confirmado });
}

/* ---------- Modelo histórico por lata (solo registros antiguos) ---------- */

/**
 * Costo total de UNA lata según la receta antigua y los precios de HOY.
 * Solo se usa como respaldo para registros antiguos sin costo congelado.
 */
function coCostoLata(receta) {
  if (!receta || !Array.isArray(receta.ingredientes) || !receta.ingredientes.length) {
    return { costoLata: 0, faltantes: [], detalle: [] };
  }
  const faltantes = [];
  const detalle = [];
  let total = 0;

  for (const ing of receta.ingredientes) {
    const ins = coInsumo(ing.insumoId);
    if (!ins) { faltantes.push(ing.insumoId); continue; }
    // La cantidad de la receta ya viene en unidad base (g / ml / und).
    const costo = coNum(ing.cantidad) * coNum(ins.precioBase);
    total += costo;
    detalle.push({ nombre: ins.nombre, cantidad: coNum(ing.cantidad), unidad: coBaseLabel(ins.unidadCompra), costo });
  }
  return { costoLata: total, faltantes, detalle };
}

/** Métricas de una receta antigua por lata. */
function coMetricasProducto(productoId) {
  const receta = coReceta(productoId);
  const { costoLata, faltantes, detalle } = coCostoLata(receta);
  const panesPorLata = Math.max(1, coNum(receta?.panesPorLata, 1));
  const pesoPorPan = coNum(receta?.pesoPorPan);          // gramos
  const pesoLata = panesPorLata * pesoPorPan;             // gramos
  return {
    receta, detalle, faltantes,
    costoLata,
    panesPorLata,
    pesoPorPan,
    pesoLata,
    costoPorPan: panesPorLata > 0 ? costoLata / panesPorLata : 0,
    costoPorKg: pesoLata > 0 ? costoLata / (pesoLata / 1000) : 0,
    costoPorGramo: pesoLata > 0 ? costoLata / pesoLata : 0
  };
}

/* ---------- Costos indirectos ---------- */

/** Costo indirecto TOTAL prorrateado a un día. Solo cuenta los activos. */
function coIndirectoDiario() {
  return (DB.costos.indirectos || [])
    .filter(c => c.activo !== false)
    .reduce((a, c) => a + coNum(c.valor) / (CO_DIAS[c.periodicidad] || 30), 0);
}

/** Costo indirecto diario desglosado por categoría. */
function coIndirectoPorCategoria() {
  const out = {};
  (DB.costos.indirectos || []).filter(c => c.activo !== false).forEach(c => {
    const dia = coNum(c.valor) / (CO_DIAS[c.periodicidad] || 30);
    out[c.categoria || 'Otros'] = (out[c.categoria || 'Otros'] || 0) + dia;
  });
  return out;
}

/* ---------- Costo variable de un producto para el punto de equilibrio ---------- */

/**
 * Costo variable unitario VIGENTE de un producto, sin ambigüedad:
 *  · una sola categoría de masa activa lo contiene → su costeo unitario;
 *  · varias → no se elige una al azar: queda sin dato;
 *  · ninguna → receta antigua por lata, si existe y está completa.
 * @returns {{valor:number|null, fuente:string, motivo:string}}
 */
function coCostoVariableVigente(productoId) {
  if (_coCacheVig.has(productoId)) return _coCacheVig.get(productoId);
  let out;
  const cats = coCategorias().filter(c => c.activo !== false && (c.productos || []).some(l => l.productoId === productoId));
  if (cats.length === 1) {
    const snap = coSnapshotCategoria(cats[0]);
    const l = snap.lineas.find(x => x.productoId === productoId);
    const u = coCosteoUnitario(snap, l);
    out = u.completo
      ? { valor: u.variablePorPan, fuente: `costeo vigente · ${cats[0].nombre}`, motivo: '' }
      : { valor: null, fuente: '', motivo: `costeo incompleto en ${cats[0].nombre}` };
  } else if (cats.length > 1) {
    out = { valor: null, fuente: '', motivo: 'pertenece a varias masas y no tuvo producción ese día' };
  } else {
    const m = coMetricasProducto(productoId);
    out = m.receta && !m.faltantes.length && m.costoLata > 0
      ? { valor: m.costoPorPan, fuente: 'receta antigua por lata', motivo: '' }
      : { valor: null, fuente: '', motivo: 'sin categoría de masa ni receta' };
  }
  _coCacheVig.set(productoId, out);
  return out;
}

/**
 * Punto de equilibrio con la mezcla REAL de productos vendidos del día.
 * Nunca rellena con cero lo que falta: si falta un costo, no es calculable.
 */
function coPuntoEquilibrio(ventasProd, costoUnit, fijos) {
  const filas = [];
  const faltan = [];
  let ingresos = 0, unidades = 0, costoVar = 0;
  for (const v of ventasProd) {
    const u = v.cobradas + v.vendajes;
    const c = costoUnit(v.productoId);
    if (c.valor == null) faltan.push(`${v.nombre} (${c.motivo})`);
    else costoVar += u * c.valor;
    ingresos += v.ingresos;
    unidades += u;
    filas.push({
      ...v, unidades: u, precioEfectivo: u > 0 ? v.ingresos / u : 0,
      costoUnit: c.valor, fuente: c.fuente, motivo: c.motivo,
      contribucion: c.valor == null ? null : v.ingresos - u * c.valor
    });
  }
  const base = { filas, ingresos, unidades, fijos, faltantes: faltan, precioProm: unidades > 0 ? ingresos / unidades : 0 };
  if (ingresos <= 0) return { ...base, calculable: false, motivo: 'Sin ventas registradas en el día.' };
  if (faltan.length) return { ...base, calculable: false, motivo: `Costeo incompleto de: ${faltan.join('; ')}.` };
  const mc = ingresos - costoVar;
  const r = {
    ...base, costoVar, mc,
    costoVarUnit: costoVar / unidades,
    mcUnitario: mc / unidades,
    razonMC: mc / ingresos
  };
  if (mc <= 0) {
    return {
      ...r, calculable: false, mcNoPositivo: true,
      motivo: `El margen de contribución es ${Math.abs(mc) < 0.5 ? 'cero' : 'negativo'}: lo cobrado no cubre el costo variable de lo entregado (incluidos vendajes y empaques). Revisa precios, vendajes o recetas.`
    };
  }
  if (fijos <= 0) {
    return { ...r, calculable: true, sinFijos: true, pePesos: 0, peUnidades: 0, motivo: 'No hay costos fijos activos: el punto de equilibrio es $0.' };
  }
  const pePesos = fijos / r.razonMC;
  return { ...r, calculable: true, sinFijos: false, pePesos, peUnidades: pePesos / r.precioProm, motivo: '' };
}

/**
 * Fotografía completa de un día: ventas, producción, costos, PE y resultado.
 * Es la única fuente de verdad de los KPIs; el dashboard, la producción, el PE
 * y los gráficos consumen esto para que nunca se contradigan entre sí.
 * @param {string} fecha 'YYYY-MM-DD'
 */
function coDia(fecha) {
  /* --- Ventas (desde los pedidos del ERP) --- */
  const pedidos = (DB.pedidos || []).filter(p => p.fecha === fecha);
  const ventasMap = new Map();
  let ventasBrutas = 0, unidadesVendidas = 0, vendajes = 0, valorVendajes = 0;
  for (const p of pedidos) {
    ventasBrutas += coNum(p.total);
    for (const i of p.items || []) {
      const q = coNum(i.cantidad), v = coNum(i.vendajes);
      unidadesVendidas += q;
      vendajes += v;
      valorVendajes += v * coNum(i.precio);
      const k = i.productoId || i.nombre;
      const e = ventasMap.get(k) || { productoId: i.productoId, nombre: coProducto(i.productoId)?.nombre || i.nombre, ingresos: 0, cobradas: 0, vendajes: 0 };
      e.ingresos += coNum(i.subtotal);
      e.cobradas += q;
      e.vendajes += v;
      ventasMap.set(k, e);
    }
  }
  // El total del pedido es Σ subtotales COBRADOS; los vendajes se entregan
  // aparte sin cobro. Restarlos otra vez descontaría ingresos que nunca entraron.
  const ventasNetas = ventasBrutas;

  /* --- Producción del día --- */
  const prod = (DB.costos.produccion || []).filter(p => p.fecha === fecha);
  const porProducto = [];      // registros antiguos por lata
  const lotes = [];            // registros nuevos por arroba
  const costoProd = new Map(); // productoId → {panes, costo, incompleto}
  const acumProd = (pid, panes, costo) => {
    const e = costoProd.get(pid) || { panes: 0, costo: 0, incompleto: false };
    e.panes += panes;
    if (costo == null) e.incompleto = true; else e.costo += costo;
    costoProd.set(pid, e);
  };

  let latas = 0, panesLata = 0, pesoG = 0, costoLata = 0;
  let arrobas = 0, libras = 0, pesoRefKg = 0, pepas = 0, bolitas = 0;
  let costoMasa = 0, costoAdicionales = 0, costoSinAsignar = 0, costoRemanentes = 0, costoPanesV2 = 0;
  let panesEstimados = 0, panesConfirmados = 0, pendientes = 0, latasEq = 0;
  let lotesIncompletos = 0;

  for (const r of prod) {
    if (!coEsV2(r)) {
      // Cálculo histórico por lata, sin cambios.
      const m = coMetricasProducto(r.productoId);
      const cl = coNum(r.costoLata) > 0 ? coNum(r.costoLata) : m.costoLata;
      const ppl = Math.max(1, coNum(r.panesPorLata, m.panesPorLata));
      const ppp = coNum(r.pesoPorPan, m.pesoPorPan);
      const nPanes = coNum(r.latas) * ppl;
      latas += coNum(r.latas);
      panesLata += nPanes;
      pesoG += nPanes * ppp;
      costoLata += coNum(r.latas) * cl;
      acumProd(r.productoId, nPanes, coNum(r.latas) * cl);
      porProducto.push({
        registroId: r.id,
        productoId: r.productoId,
        nombre: coProducto(r.productoId)?.nombre || '(producto eliminado)',
        latas: coNum(r.latas), panesPorLata: ppl, pesoPorPan: ppp,
        panes: nPanes, pesoKg: (nPanes * ppp) / 1000,
        costoLata: cl, costoTotal: coNum(r.latas) * cl,
        costoPorPan: ppl > 0 ? cl / ppl : 0
      });
      continue;
    }

    const res = coResultadoDe(r);
    if (!res) continue;
    arrobas += res.arrobas; libras += res.libras; pesoRefKg += res.pesoRefKg;
    pepas += res.pepas; bolitas += res.bolitas;
    if (res.costoTotalLote == null) lotesIncompletos++;
    else {
      costoMasa += res.costoMasaLote;
      costoAdicionales += res.costoAdicionales;
      costoSinAsignar += res.costoSinAsignar;
      costoRemanentes += res.costoRemanentes;
    }
    if (res.estado === 'pendiente') pendientes++;
    else if (res.estado === 'confirmado') panesConfirmados += res.panesConfirmados;
    else panesEstimados += res.panesEstimados;
    latasEq += res.latasEquivalentes || 0;
    for (const l of res.reparto) {
      acumProd(l.productoId, l.panesBase, l.costoTotal);
      if (l.costoTotal != null) costoPanesV2 += l.costoTotal;
    }
    lotes.push({ registro: r, res });
  }

  const costeoIncompleto = lotesIncompletos > 0;
  const panes = panesConfirmados + panesEstimados + panesLata;
  const costoMP = costoLata + costoMasa + costoAdicionales;   // costo de producción del día
  const costoIndirecto = coIndirectoDiario();
  const costoTotal = costeoIncompleto ? null : costoMP + costoIndirecto;

  /* --- Resultado operativo del día (lógica existente) --- */
  const utilidad = costoTotal == null ? null : ventasNetas - costoTotal;
  const margen = utilidad == null ? null : (ventasNetas > 0 ? (utilidad / ventasNetas) * 100 : 0);
  const rentabilidad = utilidad == null ? null : (costoTotal > 0 ? (utilidad / costoTotal) * 100 : 0);

  /* --- Punto de equilibrio --- */
  const costoUnit = (pid) => {
    const e = costoProd.get(pid);
    if (e && e.panes > 0 && !e.incompleto) return { valor: e.costo / e.panes, fuente: 'producción del día', motivo: '' };
    if (e && e.incompleto) return { valor: null, fuente: '', motivo: 'producción del día con costeo incompleto' };
    return coCostoVariableVigente(pid);
  };
  const pe = coPuntoEquilibrio([...ventasMap.values()], costoUnit, costoIndirecto);
  const pePesos = pe.calculable ? pe.pePesos : null;
  const superoPE = pe.calculable && ventasNetas >= pePesos;
  const brechaPE = pe.calculable ? ventasNetas - pePesos : null;

  /* --- Semáforo --- */
  let estado = 'equilibrio', estadoTxt = 'Punto de equilibrio', estadoIcon = '🟡';
  if (utilidad == null) { estado = 'incompleto'; estadoTxt = 'Costeo incompleto'; estadoIcon = '⚠️'; }
  else if (ventasNetas === 0 && costoTotal === 0) { estado = 'vacio'; estadoTxt = 'Sin datos'; estadoIcon = '⚪'; }
  else if (utilidad > 0.005 * Math.max(1, ventasNetas)) { estado = 'rentable'; estadoTxt = 'Rentable'; estadoIcon = '🟢'; }
  else if (utilidad < -0.005 * Math.max(1, ventasNetas)) { estado = 'perdida'; estadoTxt = 'Pérdida'; estadoIcon = '🔴'; }

  const costoAsignadoPanes = costoLata + costoPanesV2;
  return {
    fecha, pedidos: pedidos.length,
    ventasBrutas, ventasNetas, valorVendajes, vendajes, unidadesVendidas,
    unidadesEntregadas: unidadesVendidas + vendajes,
    // Producción histórica por lata
    latas, panesLata, pesoKg: pesoG / 1000, porProducto, costoLata,
    // Producción por arroba
    lotes, arrobas, libras, pesoRefKg, pepas, bolitas,
    panesEstimados, panesConfirmados, pendientes, latasEq,
    costoMasa, costoAdicionales, costoSinAsignar, costoRemanentes,
    lotesIncompletos, costeoIncompleto,
    // Consolidado
    panes, costoMP, costoIndirecto, costoTotal,
    utilidad, margen, rentabilidad,
    pe, precioProm: pe.precioProm, costoVarUnit: pe.costoVarUnit ?? null, mcUnitario: pe.mcUnitario ?? null,
    peUnidades: pe.calculable ? pe.peUnidades : null, pePesos, superoPE, brechaPE,
    costoPromedioPan: panes > 0 && !costeoIncompleto ? costoAsignadoPanes / panes : null,
    costoPromedioLata: latas > 0 ? costoLata / latas : 0,
    estado, estadoTxt, estadoIcon
  };
}

/** Devuelve los últimos N días (incluye la fecha de análisis) como 'YYYY-MM-DD'. */
function coUltimosDias(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(_coFecha + 'T12:00:00');
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * INTELIGENCIA AUTOMÁTICA — conclusiones en lenguaje natural
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Genera conclusiones a partir de los datos reales. Nunca inventa nada:
 * si no hay datos suficientes para una conclusión, esa conclusión no aparece.
 * @param {ReturnType<coDia>} d
 * @returns {{tipo:'ok'|'warn'|'bad'|'info', txt:string}[]}
 */
function coInsights(d) {
  const out = [];
  const dias7 = coUltimosDias(7).map(coDia);
  const dias30 = coUltimosDias(30).map(coDia);
  const conVentas7 = dias7.filter(x => x.ventasNetas > 0 && x.utilidad != null);
  const conVentas30 = dias30.filter(x => x.ventasNetas > 0 && x.utilidad != null);

  /* Estado general */
  if (d.estado === 'incompleto') out.push({ tipo: 'bad', txt: `Hay ${d.lotesIncompletos} lote(s) con costeo incompleto: la utilidad del día no se puede calcular hasta completar insumos o configuración.` });
  else if (d.estado === 'rentable') out.push({ tipo: 'ok', txt: `El día cerró con utilidad de ${money(d.utilidad)} (margen ${d.margen.toFixed(1)}%).` });
  else if (d.estado === 'perdida') out.push({ tipo: 'bad', txt: `El día cerró en pérdida por ${money(Math.abs(d.utilidad))}. Los costos superaron las ventas cobradas.` });
  else if (d.estado === 'equilibrio' && d.ventasNetas > 0) out.push({ tipo: 'warn', txt: 'El día quedó prácticamente en punto de equilibrio: ni gana ni pierde.' });

  /* Punto de equilibrio */
  if (d.pe.calculable && d.pe.sinFijos) out.push({ tipo: 'info', txt: 'No hay costos fijos activos: el punto de equilibrio es $0 (no por falta de datos).' });
  else if (d.pe.calculable) {
    if (d.superoPE) out.push({ tipo: 'ok', txt: `Se superó el punto de equilibrio (${money(d.pePesos)}) con un excedente de ${money(d.brechaPE)}.` });
    else out.push({ tipo: 'bad', txt: `No se alcanzó el punto de equilibrio: faltaron ${money(Math.abs(d.brechaPE))} en ventas.` });
  } else if (d.ventasNetas > 0) {
    out.push({ tipo: d.pe.mcNoPositivo ? 'bad' : 'warn', txt: `Punto de equilibrio no calculable: ${d.pe.motivo}` });
  }

  /* Vendajes */
  if (d.vendajes > 0) {
    out.push({ tipo: 'info', txt: `Se entregaron ${num(d.vendajes)} unidades de vendaje (valor comercial ${money(d.valorVendajes)}). No se restan de las ventas: ya no estaban en lo cobrado; su costo está dentro de la producción.` });
  }

  /* Producción */
  if (d.arrobas > 0) {
    out.push({ tipo: 'info', txt: `Se registraron ${coN(d.arrobas)} arrobas (${coN(d.libras, 1)} lb, ${coN(d.bolitas, 1)} bolitas).` });
  }
  if (d.panesConfirmados > 0) out.push({ tipo: 'info', txt: `Panes confirmados por conteo: ${num(d.panesConfirmados)}.` });
  if (d.panesEstimados > 0) out.push({ tipo: 'warn', txt: `${num(d.panesEstimados)} panes son una estimación por fórmula y aún no se confirman con conteo real.` });
  if (d.pendientes > 0) out.push({ tipo: 'warn', txt: `${d.pendientes} lote(s) están pendientes de reparto: su masa cuenta en el costo pero sus panes no se suman.` });
  if (d.panesLata > 0) out.push({ tipo: 'info', txt: `Registros antiguos por lata: ${num(d.panesLata)} panes en ${num(d.latas, 1)} latas.` });
  if (d.costoRemanentes > 0) out.push({ tipo: 'info', txt: `Las bolitas remanentes del reparto equivalen a ${money(d.costoRemanentes)} de masa sin convertir en pan.` });
  if (d.costoPromedioPan != null && d.panes > 0) out.push({ tipo: 'info', txt: `El costo promedio por pan fue de ${money(d.costoPromedioPan)}.` });

  /* Comparativo de costo por pan vs promedio de la semana */
  const prevPan = dias7.filter(x => x.fecha !== d.fecha && x.costoPromedioPan != null && x.panes > 0);
  if (d.costoPromedioPan != null && d.panes > 0 && prevPan.length >= 2) {
    const prom = prevPan.reduce((a, x) => a + x.costoPromedioPan, 0) / prevPan.length;
    if (prom > 0) {
      const dif = ((d.costoPromedioPan - prom) / prom) * 100;
      if (Math.abs(dif) >= 3) {
        out.push({
          tipo: dif < 0 ? 'ok' : 'warn',
          txt: `El costo promedio por pan ${dif < 0 ? 'bajó' : 'subió'} ${Math.abs(dif).toFixed(1)}% frente al promedio de los últimos 7 días.`
        });
      }
    }
  }

  /* Peso de los costos indirectos */
  if (d.costoTotal > 0) {
    const pct = (d.costoIndirecto / d.costoTotal) * 100;
    out.push({
      tipo: pct > 35 ? 'warn' : 'info',
      txt: `Los costos indirectos representan el ${pct.toFixed(1)}% del costo total del día${pct > 35 ? '. Es un peso alto: revisa arriendos, servicios y transporte.' : '.'}`
    });
  }

  /* Variación de precios de insumos */
  (DB.costos.insumos || []).forEach(ins => {
    const h = ins.historial || [];
    if (h.length < 2) return;
    const v = coNum(h[h.length - 1].variacion);
    if (Math.abs(v) >= 3) {
      out.push({
        tipo: v > 0 ? 'warn' : 'ok',
        txt: `${coEsc(ins.nombre)} ${v > 0 ? 'aumentó' : 'bajó'} un ${Math.abs(v).toFixed(1)}% en su última compra. Afecta los costeos vigentes, no las producciones ya registradas.`
      });
    }
  });

  /* Margen vs promedio semanal y mensual */
  const otros7 = conVentas7.filter(x => x.fecha !== d.fecha);
  if (d.ventasNetas > 0 && d.margen != null && otros7.length >= 2) {
    const prom = otros7.reduce((a, x) => a + x.margen, 0) / otros7.length;
    const dif = d.margen - prom;
    if (Math.abs(dif) >= 2) {
      out.push({
        tipo: dif > 0 ? 'ok' : 'warn',
        txt: `El margen de hoy (${d.margen.toFixed(1)}%) fue ${dif > 0 ? 'superior' : 'inferior'} al promedio de la semana (${prom.toFixed(1)}%).`
      });
    }
  }
  const otros30 = conVentas30.filter(x => x.fecha !== d.fecha);
  if (d.ventasNetas > 0 && d.utilidad != null && otros30.length >= 5) {
    const promU = otros30.reduce((a, x) => a + x.utilidad, 0) / otros30.length;
    if (Math.abs(d.utilidad - promU) > Math.max(1000, Math.abs(promU) * 0.1)) {
      out.push({
        tipo: d.utilidad >= promU ? 'ok' : 'warn',
        txt: `La utilidad de hoy fue ${d.utilidad >= promU ? 'superior' : 'inferior'} al promedio de los últimos 30 días (${money(promU)}).`
      });
    }
  }

  /* Configuración pendiente */
  const asociados = new Set(coCategorias().filter(c => c.activo !== false).flatMap(c => (c.productos || []).map(l => l.productoId)));
  const sinMasa = DB.productos.filter(p => p.activo && !asociados.has(p.id) && !coReceta(p.id));
  if (sinMasa.length) {
    out.push({ tipo: 'warn', txt: `${sinMasa.length} producto(s) activos no pertenecen a ninguna categoría de masa: su costo no se puede estimar.` });
  }
  const catIncompletas = coCategorias().filter(c => c.activo !== false && !coCosteoReceta(coSnapshotCategoria(c)).completo);
  if (catIncompletas.length) {
    out.push({ tipo: 'warn', txt: `Costeo incompleto en: ${catIncompletas.map(c => coEsc(c.nombre)).join(', ')}.` });
  }

  if (!out.length) out.push({ tipo: 'info', txt: 'Todavía no hay datos suficientes para sacar conclusiones. Registra insumos, categorías de masa y producción.' });
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * RENDER PRINCIPAL
 * ═══════════════════════════════════════════════════════════════════════════ */

function coDestruirGraficos() {
  _coCharts.forEach(c => { try { c.destroy(); } catch (e) { /* canvas ya removido */ } });
  _coCharts = [];
}

function renderCostos() {
  setHeader('Costos y Rentabilidad');
  coDestruirGraficos();
  _coCacheVig = new Map();

  const d = coDia(_coFecha);
  const tabs = [
    ['dashboard', 'Dashboard'], ['insumos', 'Insumos'], ['recetas', 'Masas y recetas'],
    ['produccion', 'Producción'], ['indirectos', 'Costos indirectos'],
    ['equilibrio', 'Punto de equilibrio'], ['analitica', 'Analítica']
  ];

  const body = {
    dashboard:  () => coTabDashboard(d),
    insumos:    () => coTabInsumos(),
    recetas:    () => coTabRecetas(),
    produccion: () => coTabProduccion(d),
    indirectos: () => coTabIndirectos(),
    equilibrio: () => coTabEquilibrio(d),
    analitica:  () => coTabAnalitica()
  }[_coTab]();

  $('#view').innerHTML = `
    <div class="ph">
      <div><h1>Costos y Rentabilidad</h1><div class="sub">Masas por arroba, producción en libras o arrobas, punto de equilibrio y resultado del día</div></div>
      <div class="h-spacer"></div>
      <button class="btn btn-primary" style="align-self:flex-end" onclick="coExportarCosteoExcel()" title="Descarga un Excel con el costeo completo de todos los panes"><span class="ms">table_view</span>Exportar costeo a Excel</button>
      <div class="field" style="margin:0">
        <label>Día de análisis</label>
        <input type="date" value="${_coFecha}" onchange="coSetFecha(this.value)" style="width:170px"/>
      </div>
    </div>
    <div class="menu-tabs">${tabs.map(t =>
      `<button class="menu-tab ${_coTab === t[0] ? 'active' : ''}" onclick="coSetTab('${t[0]}')">${t[1]}</button>`
    ).join('')}</div>
    <div class="fade-in">${body}</div>
  `;

  if (_coTab === 'analitica') requestAnimationFrame(coPintarGraficos);
  if (_coTab === 'equilibrio') requestAnimationFrame(() => coPintarPE(d));
}

function coSetTab(t) { _coTab = t; _coBusqueda = ''; renderCostos(); }
function coSetFecha(f) { _coFecha = f || todayKey(); renderCostos(); }

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 1 · DASHBOARD
 * ═══════════════════════════════════════════════════════════════════════════ */

function coKpi(label, valor, icono, clase = '', sub = '') {
  return `<div class="kpi">
    <div class="kpi-ico ${clase}"><span class="ms">${icono}</span></div>
    <div class="kpi-l">${label}</div>
    <div class="kpi-v">${valor}</div>
    ${sub ? `<div class="muted" style="font-size:11px;margin-top:2px">${sub}</div>` : ''}
  </div>`;
}

const coPct = (v) => (v == null ? 'No calculable' : v.toFixed(1) + '%');

/** Texto del KPI de punto de equilibrio según su estado. */
function coPeTexto(d) {
  if (!d.pe.calculable) return { v: 'No calculable', sub: d.pe.motivo };
  if (d.pe.sinFijos) return { v: money(0), sub: 'Sin costos fijos activos' };
  return { v: money(d.pePesos), sub: d.superoPE ? 'Superado ✓' : `Faltan ${money(Math.abs(d.brechaPE))}` };
}

function coTabDashboard(d) {
  const ins = coInsights(d);
  const colorEstado = { rentable: 'var(--tertiary)', equilibrio: '#f9a825', perdida: 'var(--error)', vacio: 'var(--on-surface-variant)', incompleto: '#f9a825' }[d.estado];
  const pe = coPeTexto(d);

  return `
    <div class="card mb-md" style="border-left:6px solid ${colorEstado}">
      <div class="card-b flex fb" style="flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:26px;font-weight:800;color:${colorEstado}">${d.estadoIcon} ${d.estadoTxt}</div>
          <div class="muted" style="font-size:12px">${_coFecha} · ${d.pedidos} pedido(s) · ${num(d.panesConfirmados)} panes confirmados · ${num(d.panesEstimados + d.panesLata)} estimados</div>
        </div>
        <div style="text-align:right">
          <div class="muted" style="font-size:11px">Resultado operativo del día</div>
          <div style="font-size:30px;font-weight:800;font-family:var(--font-mono);color:${colorEstado}">${d.utilidad == null ? 'No calculable' : money(d.utilidad)}</div>
        </div>
      </div>
    </div>

    <h3 class="mb-md">Ventas</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Ventas cobradas', money(d.ventasNetas), 'payments', 'kpi-ico-t', 'Total de los pedidos del día')}
      ${coKpi('Vendajes entregados', num(d.vendajes), 'redeem', 'kpi-ico-s', `Valor comercial ${money(d.valorVendajes)} · no se resta`)}
      ${coKpi('Unidades cobradas', num(d.unidadesVendidas), 'list_alt', 'kpi-ico-s', `${num(d.unidadesEntregadas)} entregadas con vendajes`)}
      ${coKpi('Precio efectivo / unidad', money(d.precioProm), 'balance', 'kpi-ico-p', 'Cobrado ÷ unidades entregadas')}
    </div>

    <h3 class="mb-md">Producción por arroba</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Arrobas', coN(d.arrobas), 'scale', 'kpi-ico-s', `${coN(d.libras, 1)} lb · ref. ${coN(d.pesoRefKg, 1)} kg de lote`)}
      ${coKpi('Bolitas', coN(d.bolitas, 1), 'bubble_chart', 'kpi-ico-p', `${coN(d.pepas, 2)} pepas grandes`)}
      ${coKpi('Panes confirmados', num(d.panesConfirmados), 'task_alt', 'kpi-ico-t', 'Conteo real')}
      ${coKpi('Panes estimados', num(d.panesEstimados), 'calculate', 'kpi-ico-s', d.pendientes ? `${d.pendientes} lote(s) pendientes de reparto` : 'Por fórmula, sin confirmar')}
    </div>
    ${d.latas > 0 ? `<div class="grid grid-4 mb-md">
      ${coKpi('Latas (registros antiguos)', num(d.latas, 1), 'inventory_2', 'kpi-ico-s')}
      ${coKpi('Panes por lata (antiguos)', num(d.panesLata), 'cake', 'kpi-ico-t')}
      ${coKpi('Kg por lata (antiguos)', num(d.pesoKg, 1) + ' kg', 'balance', 'kpi-ico-p')}
      ${coKpi('Costo por lata (antiguos)', money(d.costoLata), 'savings', 'kpi-ico-e')}
    </div>` : ''}

    <h3 class="mb-md">Costos y resultado</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Costo de masa', d.costeoIncompleto ? CO_INCOMPLETO : money(d.costoMasa), 'bakery_dining', 'kpi-ico-e', `Latas informativas: ${coN(d.latasEq, 1)}`)}
      ${coKpi('Adicionales y empaques', d.costeoIncompleto ? CO_INCOMPLETO : money(d.costoAdicionales), 'shopping_bag', 'kpi-ico-e')}
      ${coKpi('Costos indirectos', money(d.costoIndirecto), 'account_balance', 'kpi-ico-e', 'prorrateo diario')}
      ${coKpi('Costo total', coM(d.costoTotal), 'balance', 'kpi-ico-e')}
    </div>
    <div class="grid grid-4 mb-lg">
      ${coKpi('Resultado del día', d.utilidad == null ? 'No calculable' : money(d.utilidad), 'savings', 'kpi-ico-t')}
      ${coKpi('Margen sobre ventas', coPct(d.margen), 'percent', 'kpi-ico-p')}
      ${coKpi('Rentabilidad sobre costo', coPct(d.rentabilidad), 'trending_up', 'kpi-ico-t')}
      ${coKpi('Punto de equilibrio', pe.v, 'swap_horiz', 'kpi-ico-p', coEsc(pe.sub))}
    </div>

    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12px;line-height:1.6">
      <b>Resultado operativo del día</b> = ventas cobradas − costo de la producción registrada ese día − costos indirectos prorrateados.
      Es la misma lógica diaria del módulo: <b>no</b> es una contabilidad de inventarios ni un costo de ventas.
    </div></div>

    <div class="card">
      <div class="card-h"><div class="card-t">Análisis automático</div></div>
      <div class="card-b">
        ${ins.map(i => {
          const c = { ok: 'var(--tertiary)', warn: '#f9a825', bad: 'var(--error)', info: 'var(--primary)' }[i.tipo];
          const ic = { ok: 'check_circle', warn: 'history', bad: 'trending_down', info: 'balance' }[i.tipo];
          return `<div class="flex" style="gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--outline-variant)">
            <span class="ms" style="color:${c};font-size:18px">${ic}</span>
            <span style="font-size:13.5px;line-height:1.5">${i.txt}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 2 · INSUMOS (ingredientes y empaques salen del mismo catálogo)
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ---------- Ayudas de formato para el registro de compras ---------- */
let _coInsCat = '';        // filtro de categoría de la pestaña Insumos ('' = todas)
let _coInsEdit = null;     // insumo que se está editando o comprando (para comparar el precio)
/** Nombre de la unidad en plural, para las preguntas del formulario. */
const CO_UNI_PLURAL = { g: 'gramos', kg: 'kilos', ml: 'mililitros', l: 'litros', unidad: 'unidades', paquete: 'paquetes', caja: 'cajas', bulto: 'bultos' };
const CO_UNI_SING = { g: 'gramo', kg: 'kilo', ml: 'mililitro', l: 'litro', unidad: 'unidad', paquete: 'paquete', caja: 'caja', bulto: 'bulto' };
/** "1 bulto", "50 kilos". */
const coCantUni = (n, u) => `${num(n, 2)} ${(coNum(n) === 1 ? CO_UNI_SING[u] : CO_UNI_PLURAL[u]) || u}`;
const CO_UNI_ICO ={ g: '⚖️', kg: '⚖️', ml: '🧴', l: '🧴', unidad: '🔢', paquete: '📦', caja: '📦', bulto: '🛍️' };
/** Pesos escritos con puntos de mil ("120.000") → 120000. */
const coPesos = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const coFmtPesos = (n) => (n ? Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 }) : '');
/** Pone los puntos de mil mientras se escribe el precio. */
function coFmtPesosInput(el) { el.value = coFmtPesos(coPesos(el.value)); }
/** Cantidad comprada: "2,5" → 2.5 · "1.000" (punto de mil) → 1000 · "1.5" → 1.5. */
function coCant(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  const n = coDec(s);
  return Number.isFinite(n) ? n : 0;
}
/** Cantidad con coma decimal para mostrarla en un campo. */
const coFmtCant = (n) => (coNum(n) > 0 ? String(coNum(n)).replace('.', ',') : '');
/** Precio "humano" de un insumo: por kg, por litro o por unidad. */
function coPrecioHumano(precioBase, unidad) {
  const b = coBaseDe(unidad);
  if (b === 'g') return { v: precioBase * 1000, u: 'kg' };
  if (b === 'ml') return { v: precioBase * 1000, u: 'litro' };
  return { v: precioBase, u: 'unidad' };
}
const coCatDeInsumo = (i) => (i.esMezcla ? 'Mezclas' : (i.categoria || 'Otros'));

function coTarjetaInsumo(i) {
  if (i.esMezcla) {
    const m = coCosteoMezcla(i);
    return `<div class="ins-card ${m.ok ? '' : 'ins-warn'}">
      <div class="ins-nombre">${coEsc(i.nombre)} <span class="badge" style="background:#ede7f6;color:#5e35b1">Mezcla</span></div>
      <div class="ins-precio">${m.ok ? `${money(m.precioBase * 1000)} <small>/ kg</small>` : `<span class="badge badge-warn">${coEsc(m.motivo)}</span>`}</div>
      <div class="ins-ult">🥣 Rinde ${num(m.rendimiento, 2)} g · ${m.detalle.length} ingrediente(s)<br>💲 Se calcula con los precios de hoy</div>
      <div class="ins-acc">
        <button class="btn btn-secondary btn-sm ins-comprar" onclick="coMezclaModal('${i.id}')"><span class="ms">edit</span>Editar mezcla</button>
        <button class="btn btn-danger btn-sm ins-ico" title="Eliminar" onclick="coDelInsumo('${i.id}')"><span class="ms">delete</span></button>
      </div>
    </div>`;
  }
  const h = i.historial || [];
  const v = h.length >= 2 ? coNum(h[h.length - 1].variacion) : 0;
  const st = coEstadoInsumo(i);
  const ph = coPrecioHumano(coNum(i.precioBase), i.unidadCompra);
  const cont = CO_CONTENEDOR.includes(i.unidadCompra) && coNum(i.contenidoPorUnidad) > 0 ? ` de ${num(i.contenidoPorUnidad)} und` : '';
  return `<div class="ins-card ${st.ok ? '' : 'ins-warn'}">
    <div class="flex fb" style="gap:8px;align-items:flex-start">
      <div class="ins-nombre">${coEsc(i.nombre)}</div>
      ${h.length >= 2 && v !== 0 ? `<span class="badge ${v > 0 ? 'badge-error' : 'badge-success'}" title="Cambio frente a la compra anterior">${v > 0 ? '▲ +' : '▼ '}${v.toFixed(1)}%</span>` : ''}
    </div>
    ${st.ok ? `<div class="ins-precio">${ph.u === 'unidad' ? '$' + coN(ph.v, 2) : money(ph.v)} <small>/ ${ph.u}</small></div>`
      : `<div class="ins-falta">⚠ Falta: ${coEsc(st.motivo)}. Toca <b>Registrar compra</b> para completarlo.</div>`}
    <div class="ins-ult">
      🛒 ${coCantUni(i.cantidadComprada, i.unidadCompra)}${cont} por <b>${money(i.precioCompra)}</b><br>
      📅 ${i.fechaCompra ? _fechaCorta(i.fechaCompra) : '—'}${i.proveedor ? ` · 🏪 ${coEsc(i.proveedor)}` : ''}
    </div>
    <div class="ins-acc">
      <button class="btn btn-primary btn-sm ins-comprar" onclick="coCompraModal('${i.id}')"><span class="ms">add_shopping_cart</span>Registrar compra</button>
      <button class="btn btn-ghost btn-sm ins-ico" title="Historial de precios" onclick="coHistorialInsumo('${i.id}')"><span class="ms">history</span></button>
      <button class="btn btn-ghost btn-sm ins-ico" title="Editar datos del insumo" onclick="coInsumoModal('${i.id}')"><span class="ms">edit</span></button>
      <button class="btn btn-danger btn-sm ins-ico" title="Eliminar" onclick="coDelInsumo('${i.id}')"><span class="ms">delete</span></button>
    </div>
  </div>`;
}

function coTabInsumos() {
  const q = _coBusqueda.toLowerCase();
  const todos = DB.costos.insumos || [];
  const orden = [...CO_CAT_INSUMO, 'Mezclas'];
  const pos = (c) => { const k = orden.indexOf(c); return k < 0 ? orden.length : k; };
  const cats = [...new Set(todos.map(coCatDeInsumo))].sort((a, b) => pos(a) - pos(b) || a.localeCompare(b));
  if (_coInsCat && !cats.includes(_coInsCat)) _coInsCat = '';
  const lista = todos
    .filter(i => !q || i.nombre.toLowerCase().includes(q) || coCatDeInsumo(i).toLowerCase().includes(q))
    .filter(i => !_coInsCat || coCatDeInsumo(i) === _coInsCat)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  const incompletos = todos.filter(i => !coEstadoInsumo(i).ok).length;
  const grupos = cats.map(c => ({ c, items: lista.filter(i => coCatDeInsumo(i) === c) })).filter(g => g.items.length);

  return `
    <div class="ins-top">
      <button class="btn btn-primary ins-big" onclick="coCompraSelector()"><span class="ms">shopping_cart</span>Registrar compra</button>
      <button class="btn btn-secondary" onclick="coInsumoModal()"><span class="ms">add</span>Nuevo insumo</button>
      <button class="btn btn-ghost" onclick="coMezclaModal()" title="Mezcla general hecha con insumos que ya tienes (ej: cubierta de azúcar y canela)"><span class="ms">blender</span>Nueva mezcla</button>
      <input placeholder="Buscar insumo..." value="${coEsc(_coBusqueda)}" oninput="_coBusqueda=this.value;coRefrescarTabla()"/>
    </div>
    ${incompletos ? `<div class="ins-aviso">⚠ ${incompletos} insumo(s) sin costeo completo (marcados en amarillo). Ábrelos y completa lo que falta para que las masas se costeen bien.</div>` : ''}
    ${todos.length ? `<div class="reg-cats ins-chips">
      <button type="button" class="reg-cat ${!_coInsCat ? 'active' : ''}" onclick="_coInsCat='';coRefrescarTabla()">Todos (${todos.length})</button>
      ${cats.map(c => `<button type="button" class="reg-cat ${_coInsCat === c ? 'active' : ''}" data-c="${coEsc(c)}" onclick="_coInsCat=this.dataset.c;coRefrescarTabla()">${coEsc(c)} (${todos.filter(i => coCatDeInsumo(i) === c).length})</button>`).join('')}
    </div>` : ''}
    ${todos.length === 0 ? '<div class="empty">Sin insumos. Agrega el primero para poder costear tus masas.</div>'
      : grupos.length === 0 ? '<div class="empty">Ningún insumo coincide con la búsqueda.</div>'
      : grupos.map(g => `
        <div class="ins-cat-h">${coEsc(g.c)} <span class="muted">· ${g.items.length}</span></div>
        <div class="ins-grid">${g.items.map(coTarjetaInsumo).join('')}</div>`).join('')}`;
}

/** Paso previo a "Registrar compra": elegir el insumo que se compró. */
function coCompraSelector() {
  const hay = (DB.costos.insumos || []).some(i => !i.esMezcla);
  if (!hay) { toast('Primero crea el insumo con "Nuevo insumo"', 'error'); return; }
  modal('¿Qué compraste?', `
    <input id="cs-q" class="ins-input-lg" placeholder="Escribe el nombre del insumo..." oninput="coCompraSelFiltrar()" autocomplete="off" style="width:100%;font-family:inherit"/>
    <div id="cs-lista" class="ins-sel-lista"></div>
    <div class="muted" style="font-size:12.5px">¿No está en la lista? <a href="#" onclick="event.preventDefault();coInsumoModal()">Crear insumo nuevo</a></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>`);
  coCompraSelFiltrar();
  setTimeout(() => $('#cs-q')?.focus(), 50);
}
function coCompraSelFiltrar() {
  const el = $('#cs-lista');
  if (!el) return;
  const q = ($('#cs-q')?.value || '').trim().toLowerCase();
  const lista = (DB.costos.insumos || []).filter(i => !i.esMezcla && (!q || i.nombre.toLowerCase().includes(q) || (i.categoria || '').toLowerCase().includes(q)))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  el.innerHTML = lista.length ? lista.map(i => {
    const st = coEstadoInsumo(i);
    const ph = coPrecioHumano(coNum(i.precioBase), i.unidadCompra);
    return `<button type="button" class="ins-sel-item" onclick="coCompraModal('${i.id}')">
      <span><b>${coEsc(i.nombre)}</b><br><span class="muted" style="font-size:12px">${coEsc(i.categoria || 'Otros')}</span></span>
      <span class="p">${st.ok ? `${ph.u === 'unidad' ? '$' + coN(ph.v, 2) : money(ph.v)} / ${ph.u}` : '<span class="badge badge-warn">Incompleto</span>'}</span>
    </button>`;
  }).join('') : '<div class="empty">Ningún insumo coincide.</div>';
}
function coCompraModal(id) { coInsumoModal(id, 'compra'); }
/** Marca un chip de un grupo y guarda su valor en el campo oculto. */
function coChipSel(btn, hiddenId) {
  btn.parentElement.querySelectorAll('.reg-cat').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const h = document.getElementById(hiddenId);
  if (h) h.value = btn.dataset.v;
  if (hiddenId === 'ci-uni') coPreviewInsumo();
}

/** Repinta solo el cuerpo de la pestaña, sin perder el foco del buscador. */
function coRefrescarTabla() {
  const cont = document.querySelector('#view .fade-in');
  if (!cont) return;
  const activo = document.activeElement;
  const enBuscador = !!(activo && activo.matches && activo.matches('input[placeholder^="Buscar"]'));
  const pos = activo && activo.selectionStart;
  cont.innerHTML = _coTab === 'insumos' ? coTabInsumos() : cont.innerHTML;
  const nuevo = cont.querySelector('input[placeholder^="Buscar"]');
  if (nuevo && enBuscador) { nuevo.focus(); try { nuevo.setSelectionRange(pos, pos); } catch (e) { /* noop */ } }
}

/**
 * Formulario de insumo, por pasos y con botones grandes.
 *   modo 'compra' → registrar una compra nueva de un insumo que ya existe: solo
 *                   pregunta cuánto se compró y cuánto se pagó, y compara el
 *                   precio con la compra anterior.
 *   sin modo      → crear un insumo nuevo o editar todos sus datos.
 */
function coInsumoModal(id, modo) {
  if (id && coInsumo(id)?.esMezcla) return coMezclaModal(id);
  const actual = id ? coInsumo(id) : null;
  if (id && !actual) return;
  const compra = modo === 'compra' && !!actual;
  const i = actual || {
    nombre: '', categoria: 'Harinas', unidadCompra: 'kg', cantidadComprada: 0, contenidoPorUnidad: '',
    precioCompra: 0, proveedor: '', fechaCompra: todayKey(), observaciones: ''
  };
  _coInsEdit = actual ? { ...actual } : null;
  // En una compra solo se ofrecen unidades del mismo tipo (peso, volumen o
  // unidades): cambiar de gramos a unidades descuadraría las recetas.
  const unidades = compra ? CO_UNIDADES.filter(u => u.base === coBaseDe(actual.unidadCompra)) : CO_UNIDADES;
  const ph = actual ? coPrecioHumano(coNum(actual.precioBase), actual.unidadCompra) : null;
  let paso = 0;
  const P = (txt) => `<label class="reg-label mt-md"><span class="ins-paso">${++paso}</span>${txt}</label>`;

  const cabecera = compra ? `
    <div class="ins-head"><span class="ms">inventory_2</span><div>
      <div class="bold" style="font-size:16px">${coEsc(actual.nombre)}</div>
      <div class="muted" style="font-size:12px">Última compra: ${coCantUni(actual.cantidadComprada, actual.unidadCompra)} por ${money(actual.precioCompra)}${actual.fechaCompra ? ` · ${_fechaCorta(actual.fechaCompra)}` : ''}${coEstadoInsumo(actual).ok ? ` · ${ph.u === 'unidad' ? '$' + coN(ph.v, 2) : money(ph.v)} / ${ph.u}` : ''}</div>
    </div></div>
    <input type="hidden" id="ci-nombre" value="${coEsc(actual.nombre)}"/>
    <input type="hidden" id="ci-cat" value="${coEsc(actual.categoria || 'Otros')}"/>` : `
    ${P('¿Qué insumo es?')}
    <input id="ci-nombre" class="ins-input-lg" style="width:100%;font-family:inherit" value="${coEsc(i.nombre)}" placeholder="Ej: Harina de trigo, Bolsa pequeña" autocomplete="off"/>
    <label class="reg-label mt-md">Categoría</label>
    <div class="reg-cats ins-chips" style="margin-bottom:0">${CO_CAT_INSUMO.map(c => `<button type="button" class="reg-cat ${i.categoria === c ? 'active' : ''}" data-v="${c}" onclick="coChipSel(this,'ci-cat')">${c}</button>`).join('')}</div>
    <input type="hidden" id="ci-cat" value="${coEsc(CO_CAT_INSUMO.includes(i.categoria) ? i.categoria : 'Otros')}"/>`;

  modal(compra ? 'Registrar compra' : (id ? 'Editar insumo' : 'Nuevo insumo'), `
    ${cabecera}
    ${P('¿En qué lo compraste?')}
    <div class="reg-cats">${unidades.map(u => `<button type="button" class="reg-cat ${i.unidadCompra === u.v ? 'active' : ''}" data-v="${u.v}" onclick="coChipSel(this,'ci-uni')">${CO_UNI_ICO[u.v] || ''} ${u.l}</button>`).join('')}</div>
    <input type="hidden" id="ci-uni" value="${unidades.some(u => u.v === i.unidadCompra) ? i.unidadCompra : unidades[0].v}"/>
    <div class="gf mt-md" style="align-items:end">
      <div class="field" style="margin:0"><label id="ci-cant-lbl">¿Cuántos compraste? *</label>
        <input id="ci-cant" class="ins-input-lg" type="text" inputmode="decimal" value="${coFmtCant(i.cantidadComprada)}" placeholder="Ej: 50" oninput="coPreviewInsumo()" autocomplete="off"/></div>
      <div class="field" id="ci-cont-box" style="margin:0"><label id="ci-cont-lbl">¿Cuántas unidades trae cada paquete? *</label>
        <input id="ci-cont" class="ins-input-lg" type="text" inputmode="numeric" value="${coNum(i.contenidoPorUnidad) || ''}" placeholder="Ej: 200" oninput="coPreviewInsumo()" autocomplete="off"/></div>
    </div>
    ${P('¿Cuánto pagaste en total?')}
    <div class="reg-valor-wrap"><span class="reg-peso">$</span>
      <input id="ci-precio" class="reg-valor" type="text" inputmode="numeric" placeholder="0" value="${compra ? '' : coFmtPesos(i.precioCompra)}"
        oninput="coFmtPesosInput(this);coPreviewInsumo()" onkeydown="if(event.key==='Enter')coGuardarInsumo('${id || ''}','${compra ? 'compra' : ''}')" autocomplete="off"/></div>
    <div id="ci-preview" class="ins-res mt-md">—</div>
    <div class="gf3 mt-md">
      <div class="field"><label>Fecha de compra</label><input id="ci-fecha" type="date" value="${compra ? todayKey() : (i.fechaCompra || todayKey())}"/></div>
      <div class="field"><label>Proveedor</label><input id="ci-prov" value="${coEsc(i.proveedor || '')}" placeholder="Opcional"/></div>
      <div class="field"><label>Notas</label><input id="ci-obs" value="${coEsc(i.observaciones || '')}" placeholder="Opcional"/></div>
    </div>
    <div class="muted" style="font-size:11.5px">Cada compra con precio distinto queda en el historial; las producciones pasadas no cambian.</div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" style="padding:12px 22px;font-size:15px" onclick="coGuardarInsumo('${id || ''}','${compra ? 'compra' : ''}')"><span class="ms">check_circle</span>${compra ? 'Guardar compra' : 'Guardar insumo'}</button>`, 'lg');
  coPreviewInsumo();
  setTimeout(() => (compra ? $('#ci-precio') : $('#ci-nombre'))?.focus(), 50);
}

function coPreviewInsumo() {
  const el = $('#ci-preview');
  if (!el) return;
  const uni = $('#ci-uni').value;
  const contenedor = CO_CONTENEDOR.includes(uni);
  const box = $('#ci-cont-box');
  if (box) box.style.display = contenedor ? '' : 'none';
  const lbl = $('#ci-cont-lbl');
  if (lbl) lbl.textContent = `¿Cuántas unidades trae cada ${uni}? *`;
  const lblCant = $('#ci-cant-lbl');
  if (lblCant) lblCant.textContent = `¿Cuántos ${CO_UNI_PLURAL[uni] || uni} compraste? *`;

  const precio = coPesos($('#ci-precio').value);
  const calc = appwriteService.precioBaseInsumo({
    unidadCompra: uni,
    cantidadComprada: coCant($('#ci-cant').value) || 0,
    precioCompra: precio,
    contenidoPorUnidad: coCant($('#ci-cont')?.value) || 0
  });
  el.classList.remove('up', 'down');
  if (calc.contenidoPendiente) { el.textContent = `Escribe cuántas unidades trae cada ${uni} para calcular el precio.`; return; }
  if (calc.baseTotal <= 0 || precio <= 0) { el.innerHTML = '🧮 Escribe la cantidad y lo que pagaste: aquí verás a cómo te sale.'; return; }
  const ph = coPrecioHumano(calc.precioBase, uni);
  const fmt = (v) => (ph.u === 'unidad' ? '$' + coN(v, 2) : money(v));
  const base = coBaseLabel(uni);
  let cmp = '';
  const prev = _coInsEdit;
  if (prev && !prev.esMezcla && coNum(prev.precioBase) > 0 && coBaseDe(prev.unidadCompra) === coBaseDe(uni)) {
    const ant = coNum(prev.precioBase);
    const varPct = (calc.precioBase - ant) / ant * 100;
    const antH = coPrecioHumano(ant, prev.unidadCompra).v;
    if (Math.abs(varPct) < 0.05) cmp = `= Mismo precio de la compra anterior (${fmt(antH)} / ${ph.u})`;
    else {
      el.classList.add(varPct > 0 ? 'up' : 'down');
      cmp = `${varPct > 0 ? '▲' : '▼'} ${Math.abs(varPct).toFixed(1)}% ${varPct > 0 ? 'más caro' : 'más barato'} que la compra anterior (${fmt(antH)} / ${ph.u})`;
    }
  }
  el.innerHTML = `
    <div class="ins-res-main">Te sale a <b>${fmt(ph.v)}</b> ${ph.u === 'unidad' ? 'la' : 'el'} ${ph.u}</div>
    <div>${num(calc.baseTotal, 2)} ${base === 'unidad' ? 'unidades' : base} en total${base !== 'unidad' ? ` · $${num(calc.precioBase, 4)} por ${base}` : ''}</div>
    ${cmp ? `<div class="ins-res-cmp">${cmp}</div>` : ''}`;
}

async function coGuardarInsumo(id, modo) {
  const uni = $('#ci-uni').value;
  const data = {
    nombre: $('#ci-nombre').value.trim(),
    categoria: $('#ci-cat').value,
    unidadCompra: uni,
    cantidadComprada: coCant($('#ci-cant').value) || 0,
    contenidoPorUnidad: CO_CONTENEDOR.includes(uni) ? (coCant($('#ci-cont').value) || 0) : null,
    precioCompra: coPesos($('#ci-precio').value),
    proveedor: $('#ci-prov').value.trim(),
    fechaCompra: $('#ci-fecha').value,
    observaciones: $('#ci-obs').value.trim()
  };
  if (!data.nombre) { toast('Escribe el nombre del insumo', 'error'); $('#ci-nombre')?.focus(); return; }
  if (!id && (DB.costos.insumos || []).some(x => x.nombre.trim().toLowerCase() === data.nombre.toLowerCase())) {
    toast(`Ya existe un insumo llamado "${data.nombre}". Usa "Registrar compra" en su tarjeta.`, 'error'); return;
  }
  if (data.cantidadComprada <= 0) { toast('Escribe cuánto compraste', 'error'); $('#ci-cant')?.focus(); return; }
  if (CO_CONTENEDOR.includes(uni) && !(data.contenidoPorUnidad > 0)) {
    toast(`Escribe cuántas unidades trae cada ${uni}`, 'error'); $('#ci-cont')?.focus(); return;
  }
  if (data.precioCompra <= 0) { toast('Escribe cuánto pagaste', 'error'); $('#ci-precio')?.focus(); return; }

  try {
    await appwriteService.guardarInsumo(id ? { id, ...data } : data);
    saveDB(); closeModal(); _coInsEdit = null; renderCostos();
    toast(modo === 'compra' ? `Compra de ${data.nombre} registrada · costos recalculados` : 'Insumo guardado · costeos vigentes recalculados', 'success');
  } catch (e) { /* el servicio ya mostró el motivo real y revirtió la copia local */ }
}

/* ---------- Mezclas generales ---------- */

let _coMezBuf = null;   // {id, nombre, rendimiento, componentes:[{insumoId, cantidad}], observaciones}

function coMezclaModal(id) {
  const m = id ? coInsumo(id) : null;
  if (id && !m) return;
  if (!(DB.costos.insumos || []).some(i => !i.esMezcla)) { toast('Primero registra los insumos que lleva la mezcla', 'error'); return; }
  _coMezBuf = m
    ? { id: m.id, nombre: m.nombre, rendimiento: coNum(m.rendimiento), observaciones: m.observaciones || '',
        componentes: (m.componentes || []).map(g => ({ ...g })) }
    : { id: '', nombre: '', rendimiento: 0, observaciones: '', componentes: [] };
  const opc = (DB.costos.insumos || []).filter(i => !i.esMezcla).sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map(i => `<option value="${i.id}">${coEsc(i.nombre)} (${coEstadoInsumo(i).ok ? `$${num(i.precioBase, 4)}/${coBaseLabel(i.unidadCompra)}` : 'sin costeo'})</option>`).join('');
  modal(id ? `Editar mezcla · ${coEsc(m.nombre)}` : 'Nueva mezcla general', `
    <div class="muted mb-md" style="font-size:12px">Una mezcla que preparas aparte con insumos que ya tienes (ej: cubierta de azúcar, canela y mantequilla) y que solo llevan <b>algunos</b> tipos de pan.
      Después la agregas en <b>Categoría de masa → tipo de pan → Adicionales</b>, indicando cuántos gramos de mezcla lleva cada pan.</div>
    <div class="gf">
      <div class="field"><label>Nombre de la mezcla *</label><input id="mz-nombre" value="${coEsc(_coMezBuf.nombre)}" placeholder="Ej: Mezcla agridulce"/></div>
      <div class="field"><label>¿Cuántos gramos de mezcla salen? *</label>
        <input id="mz-rend" type="text" inputmode="decimal" value="${_coMezBuf.rendimiento ? String(_coMezBuf.rendimiento).replace('.', ',') : ''}" placeholder="Vacío = suma de ingredientes" oninput="coMezPreview()"/></div>
    </div>
    <h3 class="mt-md mb-sm">Ingredientes de la mezcla</h3>
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Insumo</label><select id="mz-ins">${opc}</select></div>
      <div class="field"><label>Cantidad (g, ml o und)</label><input id="mz-cant" type="text" inputmode="decimal" placeholder="Ej: 1000"/></div>
      <button class="btn btn-secondary" onclick="coMezAdd()"><span class="ms">add</span>Agregar</button>
    </div>
    <div id="mz-dyn"></div>
    <div class="field mt-md"><label>Observaciones</label><input id="mz-obs" value="${coEsc(_coMezBuf.observaciones)}"/></div>
    <div class="muted mt-sm" style="font-size:11.5px">Lo que sobra de la mezcla se usa en la siguiente tanda: no se cobra como pérdida. A cada pan solo se le cobran los gramos de mezcla que lleva.</div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarMezcla()">Guardar mezcla</button>`, 'lg');
  coMezPreview();
}
/** Rendimiento escrito o, si está vacío, la suma de los ingredientes en g/ml. */
function coMezRend() {
  const v = coDec($('#mz-rend')?.value);
  if (v > 0) return v;
  return _coMezBuf.componentes.reduce((a, g) => {
    const ins = coInsumo(g.insumoId);
    return a + (ins && coBaseDe(ins.unidadCompra) !== 'und' ? coNum(g.cantidad) : 0);
  }, 0);
}
function coMezPreview() {
  const el = $('#mz-dyn');
  if (!el || !_coMezBuf) return;
  const m = coCosteoMezcla({ componentes: _coMezBuf.componentes, rendimiento: coMezRend() });
  el.innerHTML = (m.detalle.length === 0 ? '<div class="empty">Sin ingredientes todavía.</div>' : `
    <div class="tw"><table class="d"><thead><tr><th>Insumo</th><th>Cantidad</th><th>Precio unitario</th><th>Costo</th><th></th></tr></thead><tbody>
      ${m.detalle.map((g, i) => `<tr>
        <td class="bold">${coEsc(g.nombre)}</td>
        <td><input type="text" inputmode="decimal" value="${String(g.cantidad).replace('.', ',')}" onchange="coMezSet(${i},this.value)" style="width:110px"/> <span class="muted">${g.unidad}</span></td>
        <td class="num">${g.ok ? '$' + num(g.precioBase, 4) : `<span class="badge badge-warn">${coEsc(g.motivo)}</span>`}</td>
        <td class="num bold">${coM(g.costo)}</td>
        <td><button class="btn btn-danger btn-sm" onclick="coMezDel(${i})"><span class="ms">delete</span></button></td>
      </tr>`).join('')}
    </tbody></table></div>`) + `
    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-family:var(--font-mono);font-size:13px;line-height:1.8">
      Costo total de la mezcla: <b>${money(m.costoTotal)}</b><br>
      Rinde: <b>${num(m.rendimiento, 2)} g</b>${coDec($('#mz-rend')?.value) > 0 ? '' : ' <span class="muted">(suma de ingredientes)</span>'}<br>
      Costo por gramo de mezcla: <b>${m.ok ? '$' + num(m.precioBase, 4) : '—'}</b>
      ${m.ok ? ` · por 10 g: <b>${money(m.precioBase * 10)}</b>` : ''}
      ${!m.ok && m.detalle.length ? `<br><span style="color:var(--error)">⚠ ${coEsc(m.motivo)}</span>` : ''}
    </div></div>`;
}
function coMezAdd() {
  const insumoId = $('#mz-ins').value;
  const cantidad = coDec($('#mz-cant').value);
  if (!insumoId) return;
  if (!(cantidad > 0)) { toast('Cantidad inválida', 'error'); return; }
  const ex = _coMezBuf.componentes.find(g => g.insumoId === insumoId);
  if (ex) ex.cantidad = coNum(ex.cantidad) + cantidad;
  else _coMezBuf.componentes.push({ insumoId, cantidad });
  $('#mz-cant').value = '';
  coMezPreview();
}
function coMezSet(i, v) {
  const n = coDec(v);
  if (n > 0) _coMezBuf.componentes[i].cantidad = n; else toast('Cantidad inválida', 'error');
  coMezPreview();
}
function coMezDel(i) { _coMezBuf.componentes.splice(i, 1); coMezPreview(); }
async function coGuardarMezcla() {
  const b = _coMezBuf;
  const nombre = $('#mz-nombre').value.trim();
  const rendimiento = coMezRend();
  if (!nombre) { toast('La mezcla necesita un nombre', 'error'); return; }
  if (!b.componentes.length) { toast('Agrega al menos un ingrediente', 'error'); return; }
  if (!(rendimiento > 0)) { toast('Indica cuántos gramos de mezcla salen', 'error'); return; }
  if ((DB.costos.insumos || []).some(i => i.id !== b.id && i.nombre.trim().toLowerCase() === nombre.toLowerCase())) {
    toast(`Ya existe un insumo llamado "${nombre}"`, 'error'); return;
  }
  const m = coCosteoMezcla({ componentes: b.componentes, rendimiento });
  const data = {
    nombre, esMezcla: true, categoria: 'Mezclas',
    componentes: b.componentes.map(g => ({ insumoId: g.insumoId, cantidad: coNum(g.cantidad) })),
    rendimiento,
    // Para el servicio es un insumo comprado "en gramos": rinde X g y cuesta Σ ingredientes.
    unidadCompra: 'g', cantidadComprada: rendimiento, precioCompra: m.costoTotal, contenidoPorUnidad: null,
    proveedor: '', fechaCompra: todayKey(), observaciones: $('#mz-obs').value.trim()
  };
  try {
    await appwriteService.guardarInsumo(b.id ? { id: b.id, ...data } : data);
    saveDB(); closeModal(); _coMezBuf = null; renderCostos();
    toast('Mezcla guardada · agrégala en el tipo de pan que la lleva', 'success');
  } catch (e) { /* el servicio ya mostró el motivo */ }
}

function coDelInsumo(id) {
  const i = coInsumo(id);
  if (!i) return;
  const usaMezcla = (DB.costos.insumos || []).filter(m => m.esMezcla && (m.componentes || []).some(g => g.insumoId === id));
  const usaReceta = (DB.costos.recetas || []).filter(r => (r.ingredientes || []).some(g => g.insumoId === id));
  const usaCat = coCategorias().filter(c =>
    (c.ingredientes || []).some(g => g.insumoId === id) ||
    (c.adicionales || []).some(a => a.insumoId === id) ||
    (c.productos || []).some(l => (l.adicionales || []).some(a => a.insumoId === id)));
  modal('Eliminar insumo', `
    <p>Se eliminará <b>${coEsc(i.nombre)}</b> y todo su historial de precios.</p>
    ${usaCat.length ? `<p class="mt-md" style="color:var(--error)"><b>Atención:</b> se usa en <b>${usaCat.length} categoría(s) de masa</b>
      (${usaCat.map(c => coEsc(c.nombre)).join(', ')}). Su costeo quedará como <b>Costeo incompleto</b> hasta reemplazarlo.</p>` : ''}
    ${usaReceta.length ? `<p class="mt-md" style="color:var(--error)">También aparece en <b>${usaReceta.length} receta(s) antigua(s) por lata</b>.</p>` : ''}
    ${usaMezcla.length ? `<p class="mt-md" style="color:var(--error)">Es ingrediente de <b>${usaMezcla.length} mezcla(s)</b> (${usaMezcla.map(m => coEsc(m.nombre)).join(', ')}): quedarán con costeo incompleto.</p>` : ''}
    <p class="muted mt-md" style="font-size:12px">Las producciones ya registradas conservan su costo congelado.</p>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelInsumoOk('${id}')">Eliminar</button>`);
}
async function coDelInsumoOk(id) {
  try { await appwriteService.eliminarInsumo(id); saveDB(); closeModal(); renderCostos(); toast('Insumo eliminado', 'success'); }
  catch (e) { /* toast ya mostrado */ }
}

function coHistorialInsumo(id) {
  const i = coInsumo(id);
  if (!i) return;
  const h = [...(i.historial || [])].reverse();
  const base = coBaseLabel(i.unidadCompra);
  modal(`Historial de precios · ${coEsc(i.nombre)}`, `
    ${h.length === 0 ? '<div class="empty">Sin historial todavía.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Fecha</th><th>Cantidad</th><th>Precio compra</th><th>Precio / ${base}</th><th>Variación</th>
    </tr></thead><tbody>
      ${h.map(x => {
        const v = coNum(x.variacion);
        return `<tr>
          <td>${x.fecha}</td>
          <td class="num">${num(x.cantidad, 2)} ${x.unidad}${coNum(x.contenidoPorUnidad) > 0 ? ` × ${num(x.contenidoPorUnidad)}` : ''}</td>
          <td class="num">${money(x.precioCompra)}</td>
          <td class="num bold">$${num(x.precioBase, 4)}</td>
          <td>${v === 0 ? '<span class="muted">—</span>' :
            `<span class="badge ${v > 0 ? 'badge-error' : 'badge-success'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`}</td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`}
    <div class="muted mt-md" style="font-size:12px">Cada cambio de precio queda registrado aquí. Modificar el precio actual no borra el historial ni cambia producciones pasadas.</div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cerrar</button>`);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 3 · MASAS Y RECETAS (categorías de masa por arroba)
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabRecetas() {
  const cats = coCategorias().slice().sort((a, b) => (b.activo !== false) - (a.activo !== false) || a.nombre.localeCompare(b.nombre));
  const legacyRec = (DB.costos.recetas || []).filter(r => !coEsV2(r));
  const legacyProd = (DB.costos.produccion || []).filter(r => !coEsV2(r));
  const sinMarcar = [...legacyRec, ...legacyProd].filter(r => !r.modelo).length;

  return `
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px;line-height:1.6">
      <b>Categoría de masa → receta por arroba o media arroba → tipos de pan → bolitas por pan.</b>
      La receta se escribe una vez por masa y todos sus panes la comparten. Con los parámetros iniciales,
      1 arroba = 25 lb (referencia operativa, ~12 kg de lote) = 4 pepas grandes; <b>Pique: 36 bolitas por pepa</b> → 144 bolitas.
      Un cambio de precio de insumos actualiza estas estimaciones; las producciones registradas conservan su costo.
    </div></div>
    <div class="flex gap mb-md" style="flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" onclick="coCatModal()"><span class="ms">add</span>Nueva categoría de masa</button>
      <span class="muted" style="font-size:12px">${cats.length} categoría(s)</span>
    </div>
    ${cats.length === 0 ? '<div class="empty">Sin categorías de masa. Crea la primera (ej: Masa tradicional) para costear tus panes por arroba.</div>' :
      cats.map(coCardCategoria).join('')}

    <details class="card mt-lg" ${legacyRec.length ? '' : 'open'}>
      <summary class="card-h" style="cursor:pointer"><div class="card-t">Recetas antiguas por lata (histórico) · ${legacyRec.length}</div></summary>
      <div class="card-b">
        <div class="muted mb-md" style="font-size:12px;line-height:1.6">
          Se conservan para los ${legacyProd.length} registro(s) de producción por lata, que mantienen su cálculo original.
          No se convierten automáticamente a arrobas: faltan datos para hacerlo con certeza. Los registros nuevos usan las categorías de masa.
        </div>
        ${sinMarcar ? `<div class="flex gap mb-md" style="align-items:center;flex-wrap:wrap">
          <span class="badge badge-warn">${sinMarcar} registro(s) antiguos sin marca de modelo</span>
          <button class="btn btn-secondary btn-sm" onclick="coMigrar()"><span class="ms">sync</span>Marcar como modelo antiguo (lata_v1)</button>
          <span class="muted" style="font-size:11px">Seguro de repetir: no duplica ni borra nada.</span>
        </div>` : (legacyRec.length + legacyProd.length ? '<div class="muted mb-md" style="font-size:11.5px">✓ Todos los registros antiguos están identificados como lata_v1.</div>' : '')}
        ${coTablaRecetasLegacy()}
      </div>
    </details>`;
}

function coCardCategoria(c) {
  const snap = coSnapshotCategoria(c);
  const rc = coCosteoReceta(snap);
  const act = c.activo !== false;
  return `
    <div class="card mb-md" style="${act ? '' : 'opacity:.6'}">
      <div class="card-h flex fb" style="flex-wrap:wrap;gap:8px">
        <div class="card-t">${coEsc(c.nombre)}
          <span class="badge ${act ? 'badge-success' : ''}">${act ? 'Activa' : 'Inactiva'}</span>
          ${rc.completo ? '' : CO_INCOMPLETO}
        </div>
        <div>
          <button class="btn btn-ghost btn-sm" title="${act ? 'Desactivar' : 'Activar'}" onclick="coToggleCategoria('${c.id}',${!act})"><span class="ms">${act ? 'visibility_off' : 'visibility'}</span></button>
          <button class="btn btn-ghost btn-sm" onclick="coCatModal('${c.id}')"><span class="ms">edit</span></button>
          <button class="btn btn-danger btn-sm" onclick="coDelCategoria('${c.id}')"><span class="ms">delete</span></button>
        </div>
      </div>
      <div class="card-b">
        <div class="grid grid-4 mb-md">
          ${coKpi(`Receta base (${coN(rc.arrobasBase)} @)`, coM(rc.costoRecetaBase), 'receipt_long', 'kpi-ico-p', `${rc.detalle.length} ingrediente(s)`)}
          ${coKpi('Masa por arroba', coM(rc.costoMasaPorArroba), 'scale', 'kpi-ico-e', `½ arroba: ${rc.completo ? money(rc.costoMasaMediaArroba) : '—'}`)}
          ${coKpi('Costo por bolita', coM2(rc.costoPorBolita), 'bubble_chart', 'kpi-ico-s', `${num(rc.bolitasPorArroba)} bolitas por arroba`)}
          ${coKpi('Parámetros', `${coN(snap.parametros.librasPorArroba)} lb/@`, 'tune', 'kpi-ico-p',
            `${snap.parametros.pepasPorArroba} pepas · Pique: ${snap.parametros.bolitasPorPepa} bolitas por pepa`)}
        </div>
        ${rc.motivos.length ? `<div class="mb-md" style="color:var(--error);font-size:12px">⚠ ${rc.motivos.map(coEsc).join(' · ')}</div>` : ''}
        ${coTablaProductosCategoria(snap, rc)}
        ${c.observaciones ? `<div class="muted mt-sm" style="font-size:12px">${coEsc(c.observaciones)}</div>` : ''}
      </div>
    </div>`;
}

/** Tabla de costos y márgenes por tipo de pan de una categoría. */
function coTablaProductosCategoria(snap, rc) {
  if (!snap.lineas.length) return '<div class="empty">Sin tipos de pan asociados.</div>';
  return `<div class="tw"><table class="d"><thead><tr>
      <th>Tipo de pan</th><th>Bolitas por pan</th><th>Panes / arroba</th><th>Masa / pan</th>
      <th>Adicionales / pan</th><th>Costo variable / pan</th><th>Precio venta</th><th>Margen unitario</th><th>Latas</th>
    </tr></thead><tbody>
    ${snap.lineas.map(l => {
      const u = coCosteoUnitario(snap, l, rc);
      return `<tr>
        <td class="bold">${coEsc(l.nombre)}</td>
        <td class="center">${coN(l.bolitasPorPan, 4)}</td>
        <td class="center">${u.panesPorArroba == null ? '-' : num(u.panesPorArroba)}</td>
        <td class="num">${coM(u.masaPorPan)}</td>
        <td class="num">${coM(u.adicionalesPorPan)}${u.porGrupo ? ' <span class="muted" title="Promedio por grupo completo; el costo real depende del tamaño del lote">*</span>' : ''}
          ${u.fijoPorLote > 0 ? `<div class="muted" style="font-size:11px">+ ${money(u.fijoPorLote)} fijo por registro</div>` : ''}</td>
        <td class="num bold">${coM(u.variablePorPan)}</td>
        <td class="num">${l.precioVenta == null ? '-' : money(l.precioVenta)}</td>
        <td>${u.margen == null ? CO_INCOMPLETO : `<span class="bold" style="color:${u.margen > 0 ? 'var(--tertiary)' : 'var(--error)'}">${money(u.margen)} · ${u.margenPct == null ? '-' : u.margenPct.toFixed(0) + '%'}</span>`}</td>
        <td>${l.panesPorLata ? `${num(l.panesPorLata)} por lata` : '<span class="muted">Sin configuración de latas</span>'}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
}

async function coToggleCategoria(id, activo) {
  const c = coCategoria(id);
  if (!c) return;
  try { await appwriteService.guardarCategoriaMasa({ ...c, activo }); saveDB(); renderCostos(); }
  catch (e) { /* toast ya mostrado */ }
}

function coDelCategoria(id) {
  const c = coCategoria(id);
  if (!c) return;
  const usos = (DB.costos.produccion || []).filter(r => r.categoriaId === id).length;
  modal('Eliminar categoría de masa', `
    <p>Se eliminará <b>${coEsc(c.nombre)}</b> con su receta y sus tipos de pan asociados (los productos del catálogo no se borran).</p>
    ${usos ? `<p class="mt-md">Tiene <b>${usos} producción(es)</b> registradas: conservan su fotografía y sus resultados. Si solo quieres dejar de usarla, <b>desactívala</b>.</p>` : ''}`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelCategoriaOk('${id}')">Eliminar</button>`);
}
async function coDelCategoriaOk(id) {
  try { await appwriteService.eliminarCategoriaMasa(id); saveDB(); closeModal(); renderCostos(); toast('Categoría eliminada', 'success'); }
  catch (e) { /* toast ya mostrado */ }
}

async function coMigrar() {
  try {
    const r = await appwriteService.migrarCostosV2();
    saveDB(); renderCostos();
    toast(`Marcados: ${r.recetas} receta(s) y ${r.produccion} producción(es)${r.errores ? ` · ${r.errores} con error (reintenta)` : ''}`, r.errores ? 'error' : 'success');
  } catch (e) { toast('No se pudo completar la marca de registros antiguos', 'error'); }
}

/* ---------- Modal de categoría de masa ---------- */

/* PANES POR PESO (no por pique)
 *   Se pesa la masa cruda que sale de 1 arroba (pesoMasaKg de la categoría).
 *   peso de 1 bolita  = pesoMasa por arroba ÷ bolitas por arroba
 *   costo por gramo   = costo de masa por arroba ÷ pesoMasa por arroba
 *   bolitas por pan   = (gramos de la pieza ÷ partes en que se corta) ÷ peso de 1 bolita
 * El resto del módulo sigue trabajando con bolitasPorPan, así que producción,
 * reparto y utilidad no cambian. */
let _coLModo = 'bolitas';

/** Gramos de masa cruda que salen de 1 arroba (null si no se ha indicado). */
function coPesoMasaArrobaG(b) {
  const kg = coDec(b?.pesoMasaKg);
  return kg > 0 ? kg * 1000 : null;
}
/** Suma de los ingredientes en g/ml por 1 arroba (estimado: el agua suele no estar como insumo). */
function coSumaIngArrobaG(b) {
  const ab = coNum(b?.arrobasBase);
  if (!(ab > 0)) return null;
  let s = 0;
  (b.ingredientes || []).forEach(g => {
    const ins = coInsumo(g.insumoId);
    if (ins && coBaseDe(ins.unidadCompra) !== 'und') s += coNum(g.cantidad);
  });
  return s > 0 ? s / ab : null;
}
/** Peso (g) de 1 bolita según el peso de la masa de la categoría. */
function coPesoBolitaG(b) {
  const pm = coPesoMasaArrobaG(b);
  const p = coParams(b?.parametros);
  const bpa = p.pepasPorArroba * p.bolitasPorPepa;
  return pm && bpa > 0 ? pm / bpa : null;
}
/** Bolitas por pan a partir de gramos de la pieza y partes. null si falta el peso de la masa. */
function coBppDeGramos(b, gramos, piezas) {
  const pb = coPesoBolitaG(b);
  const g = coDec(gramos), n = Math.max(1, Math.round(coDec(piezas) || 1));
  return pb && g > 0 ? coLeerBpp(g / n / pb) : null;
}

const coOpcInsumos = (sel) => (DB.costos.insumos || []).slice()
  .sort((a, b) => (b.esMezcla ? 1 : 0) - (a.esMezcla ? 1 : 0) || a.nombre.localeCompare(b.nombre))
  .map(i => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${i.esMezcla ? 'MEZCLA · ' : ''}${coEsc(i.nombre)} (${coEstadoInsumo(i).ok ? `$${num(i.precioBase, 4)}/${coBaseLabel(i.unidadCompra)}` : 'sin costeo'})</option>`).join('');

function coCatModal(id) {
  const c = id ? coCategoria(id) : null;
  if (id && !c) return;
  if (!(DB.costos.insumos || []).length) { toast('Primero registra al menos un insumo', 'error'); return; }
  _coCatBuf = c ? JSON.parse(JSON.stringify(c)) : {
    nombre: '', activo: true, observaciones: '', arrobasBase: 1,
    parametros: { ...CO_PARAM_DEF }, ingredientes: [], adicionales: [], productos: [], repartoPredeterminado: {}
  };
  _coCatBuf.parametros = coParams(_coCatBuf.parametros);
  _coCatAbierta = -1;
  _coLModo = 'bolitas';
  const ab = coNum(_coCatBuf.arrobasBase, 1);
  const esp = ab !== 1 && ab !== 0.5;
  const p = _coCatBuf.parametros;

  modal(id ? `Categoría de masa · ${coEsc(c.nombre)}` : 'Nueva categoría de masa', `
    <div class="gf">
      <div class="field"><label>Nombre *</label><input id="cm-nombre" value="${coEsc(_coCatBuf.nombre)}" placeholder="Ej: Masa tradicional"/></div>
      <div class="field"><label>Estado</label><select id="cm-activo">
        <option value="true" ${_coCatBuf.activo !== false ? 'selected' : ''}>Activa</option>
        <option value="false" ${_coCatBuf.activo === false ? 'selected' : ''}>Inactiva</option></select></div>
    </div>
    <div class="gf">
      <div class="field"><label>La receta está escrita para *</label>
        <select id="cm-ab-sel" onchange="coCatCampos()">
          <option value="1" ${ab === 1 ? 'selected' : ''}>1 arroba</option>
          <option value="0.5" ${ab === 0.5 ? 'selected' : ''}>Media arroba</option>
          <option value="otra" ${esp ? 'selected' : ''}>Otra cantidad (arrobas)</option>
        </select></div>
      <div class="field" id="cm-ab-box" style="${esp ? '' : 'display:none'}"><label>Arrobas de la receta base</label>
        <input id="cm-ab" type="text" inputmode="decimal" value="${esp ? String(ab).replace('.', ',') : ''}" placeholder="Ej: 1,5" onchange="coCatCampos()"/></div>
    </div>
    <details class="mb-md"><summary style="cursor:pointer;font-weight:700;font-size:13px">Equivalencias y rendimiento</summary>
      <div class="gf mt-sm">
        <div class="field"><label>Libras por arroba (operativa)</label><input id="cm-lpa" type="number" step="any" value="${p.librasPorArroba}" onchange="coCatCampos()"/></div>
        <div class="field"><label>Peso de referencia por arroba (kg, aprox.)</label><input id="cm-kpa" type="number" step="any" value="${p.kgRefPorArroba}" onchange="coCatCampos()"/></div>
        <div class="field"><label>Pepas grandes por arroba</label><input id="cm-ppa" type="number" step="any" value="${p.pepasPorArroba}" onchange="coCatCampos()"/></div>
        <div class="field"><label>Pique: bolitas por pepa</label><input id="cm-bpp" type="number" step="1" value="${p.bolitasPorPepa}" onchange="coCatCampos()"/></div>
      </div>
      <div class="muted" style="font-size:11px">Las libras y el peso en kg son referencias operativas del negocio, no una conversión física exacta entre sí. El peso es del lote de masa, no del pan horneado.</div>
    </details>
    <div id="cm-dyn"></div>
    <div class="field mt-md"><label>Observaciones</label><input id="cm-obs" value="${coEsc(_coCatBuf.observaciones || '')}"/></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarCategoria()">Guardar categoría</button>`, 'lg');
  coCatRender();
}

/** Lee los campos fijos del modal al buffer y repinta lo dinámico. */
function coCatCampos() {
  const b = _coCatBuf;
  if (!b) return;
  b.nombre = $('#cm-nombre')?.value.trim() ?? b.nombre;
  b.activo = $('#cm-activo')?.value !== 'false';
  b.observaciones = $('#cm-obs')?.value.trim() ?? b.observaciones;
  const sel = $('#cm-ab-sel')?.value;
  const box = $('#cm-ab-box');
  if (box) box.style.display = sel === 'otra' ? '' : 'none';
  b.arrobasBase = sel === 'otra' ? coDec($('#cm-ab').value) : Number(sel);
  b.parametros = {
    librasPorArroba: coNum($('#cm-lpa')?.value),
    kgRefPorArroba: coNum($('#cm-kpa')?.value),
    pepasPorArroba: coNum($('#cm-ppa')?.value),
    bolitasPorPepa: coNum($('#cm-bpp')?.value)
  };
  const pm = $('#cm-pm');
  if (pm) { const v = coDec(pm.value); b.pesoMasaKg = v > 0 ? v : null; }
  // Los panes armados por peso se reconvierten a bolitas con el peso vigente.
  b.productos.forEach(l => {
    if (!(coNum(l.gramosMasa) > 0)) return;
    const bpp = coBppDeGramos(b, l.gramosMasa, l.piezas);
    if (bpp) l.bolitasPorPan = bpp;
  });
  coCatRender();
}

function coCatRender() {
  const el = $('#cm-dyn');
  const b = _coCatBuf;
  if (!el || !b) return;
  const snap = coSnapshotCategoria({ ...b, parametros: coParams(b.parametros) });
  const rc = coCosteoReceta(snap);
  const ab = coNum(b.arrobasBase);
  const usados = new Set(b.productos.map(l => l.productoId));
  const disponibles = DB.productos.filter(p => p.activo && !usados.has(p.id)).sort((x, y) => x.orden - y.orden);
  const sumaIng = coSumaIngArrobaG(b);
  const pesoBol = coPesoBolitaG(b);
  const pmG = coPesoMasaArrobaG(b);
  const cxg = pmG && rc.costoMasaPorArroba != null ? rc.costoMasaPorArroba / pmG : null;

  el.innerHTML = `
    <h3 class="mt-md mb-sm">Ingredientes para ${ab > 0 ? coN(ab) + ' arroba(s)' : '—'}</h3>
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Insumo</label><select id="cm-ins">${coOpcInsumos()}</select></div>
      <div class="field"><label>Cantidad (unidad base: g, ml o und)</label><input id="cm-cant" type="number" step="any" placeholder="Ej: 6000"/></div>
      <button class="btn btn-secondary" onclick="coCatAddIng()"><span class="ms">add</span>Agregar</button>
    </div>
    ${b.ingredientes.length === 0 ? '<div class="empty">Sin ingredientes todavía.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Insumo</th><th>Cantidad (receta base)</th><th>Equivalente por 1 arroba</th><th>Precio unitario</th><th>Costo</th><th></th>
    </tr></thead><tbody>
      ${rc.detalle.map((g, i) => `<tr>
        <td class="bold">${coEsc(g.nombre)}</td>
        <td><input type="number" step="any" value="${g.cantidad}" onchange="coCatSetIng(${i},this.value)" style="width:110px"/> <span class="muted">${g.unidad}</span></td>
        <td class="num">${g.porArroba == null ? '-' : coN(g.porArroba) + ' ' + g.unidad}</td>
        <td class="num">${g.ok ? '$' + num(g.precioBase, 4) : `<span class="badge badge-warn">${coEsc(g.motivo)}</span>`}</td>
        <td class="num bold">${coM(g.costo)}</td>
        <td><button class="btn btn-danger btn-sm" onclick="coCatDelIng(${i})"><span class="ms">delete</span></button></td>
      </tr>`).join('')}
    </tbody></table></div>`}

    <h3 class="mt-md mb-sm">Adicionales de la masa (una vez por lote)</h3>
    <div class="muted mb-sm" style="font-size:11.5px">Insumos externos que no cambian el rendimiento (ej: desmoldante). Se cobran una sola vez por registro, aunque el lote se reparta en varios panes.</div>
    ${coAdForm('cm-ad', `<option value="arroba">${CO_BASES_AD.arroba}</option><option value="lote">${CO_BASES_AD.lote}</option>`)}
    <button class="btn btn-secondary btn-sm mb-sm" onclick="coCatAddAd()"><span class="ms">add</span>Agregar adicional</button>
    ${coCatTablaAd(snap.adicionales, 'coCatDelAd', null)}

    <div class="card mt-md" style="background:#fff8e6;border:1px solid #f0d48a"><div class="card-b">
      <div class="bold" style="font-size:13.5px"><span class="ms" style="vertical-align:-4px">scale</span> Panes por peso (los que no van por pique)</div>
      <div class="muted mb-sm" style="font-size:11.5px">Pesa la masa <b>cruda</b> que sale de 1 arroba, ya amasada, y escríbela aquí. Con ese dato el panel sabe cuánto vale cada gramo de masa y puedes armar cualquier pan escribiendo sus gramos (panzotes, tiras, molde, tajado…).</div>
      <div class="gf3" style="align-items:end">
        <div class="field"><label>Peso de la masa de 1 arroba (kg)</label>
          <input id="cm-pm" type="text" inputmode="decimal" value="${coPesoMasaArrobaG(b) ? String(coDec(b.pesoMasaKg)).replace('.', ',') : ''}" placeholder="Ej: 19,5" onchange="coCatCampos()"/></div>
        ${sumaIng ? `<div class="field"><label>Suma de los ingredientes</label>
          <div class="flex gap" style="align-items:center"><b>${coN(sumaIng / 1000, 2)} kg</b>
          <button class="btn btn-ghost btn-sm" onclick="coCatUsarSuma()">Usar este peso</button></div></div>` : ''}
      </div>
      ${sumaIng ? `<div class="muted" style="font-size:11px">La suma no incluye el agua ni lo que no esté como insumo; lo más exacto es pesar la masa.</div>` : ''}
      ${pesoBol ? `<div class="mt-sm" style="font-family:var(--font-mono);font-size:13px;line-height:1.8">
          1 bolita ≈ <b>${coN(pesoBol, 1)} g</b>
          ${cxg != null ? ` · 1 g de masa = <b>$${coN(cxg, 2)}</b> · 100 g = <b>${money(cxg * 100)}</b>` : ''}</div>`
        : `<div class="mt-sm" style="font-size:12px;color:#8a5a00">Escribe el peso para poder armar panes por gramos.</div>`}
    </div></div>

    <h3 class="mt-md mb-sm">Tipos de pan de esta masa</h3>
    <div class="flex gap mb-sm" style="flex-wrap:wrap;align-items:center">
      <span class="muted" style="font-size:12px">¿Cómo se arma este pan?</span>
      <button class="btn btn-sm ${_coLModo === 'bolitas' ? 'btn-primary' : 'btn-ghost'}" onclick="coCatLModo('bolitas')"><span class="ms">bubble_chart</span>Por bolitas (pique)</button>
      <button class="btn btn-sm ${_coLModo === 'peso' ? 'btn-primary' : 'btn-ghost'}" onclick="coCatLModo('peso')"><span class="ms">scale</span>Por peso (gramos)</button>
    </div>
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Producto del catálogo</label>
        <select id="cm-prod">${disponibles.map(p => `<option value="${p.id}">${coEsc(p.nombre)} (${money(p.precio)})</option>`).join('') || '<option value="">(todos asociados)</option>'}</select></div>
      ${_coLModo === 'peso' ? `
      <div class="field"><label>Gramos de masa cruda de la pieza *</label><input id="cm-lg" type="text" inputmode="decimal" placeholder="Ej: 600" oninput="coCatPrevPeso()"/></div>
      <div class="field"><label>¿En cuántas partes se corta?</label><input id="cm-lpz" type="number" min="1" step="1" value="1" oninput="coCatPrevPeso()"/></div>`
      : `<div class="field"><label>Bolitas por pan * <span class="muted" style="font-weight:400">(acepta decimales: 0,72)</span></label><input id="cm-lbpp" type="text" inputmode="decimal" value="1"/></div>`}
      <div class="field"><label>${_coLModo === 'peso' ? 'Unidades por lata (opcional)' : 'Panes por lata (opcional)'}</label><input id="cm-lppl" type="number" min="1" step="1" placeholder="Sin latas"/></div>
    </div>
    ${_coLModo === 'peso' ? `<div id="cm-lprev" class="mb-sm" style="font-size:12.5px"></div>
      <div class="muted mb-sm" style="font-size:11px">Si la pieza se corta (ej: panzote de 600 g en 10 tiras), cada parte es la unidad que vendes: el panel costea cada tira. Las unidades por lata también van en partes (4 panzotes × 10 tiras = 40).</div>` : ''}
    <div class="flex gap mb-sm" style="flex-wrap:wrap">
      <button class="btn btn-secondary btn-sm" onclick="coCatAddLinea()"><span class="ms">add</span>Asociar producto</button>
      <button class="btn btn-ghost btn-sm" onclick="const f=$('#cm-np');f.style.display=f.style.display==='none'?'':'none'"><span class="ms">add_circle</span>Crear producto nuevo</button>
    </div>
    <div id="cm-np" class="card mb-sm" style="display:none;background:var(--surface-container-low)"><div class="card-b">
      <div class="gf3" style="align-items:end">
        <div class="field"><label>Nombre del producto</label><input id="cm-np-nombre" placeholder="Ej: Pan de 1.000"/></div>
        <div class="field"><label>Precio de venta ($)</label><input id="cm-np-precio" type="number" step="any"/></div>
        <button class="btn btn-primary btn-sm" onclick="coCatNuevoProducto()">Crear y asociar</button>
      </div>
      <div class="muted" style="font-size:11px">Se crea en el catálogo de productos (pedidos y facturación) con la masa por pan indicada arriba (bolitas o gramos).</div>
    </div></div>
    ${b.productos.length === 0 ? '<div class="empty">Sin tipos de pan asociados.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Producto</th><th>Masa por pan</th><th>Panes / lata</th><th>Variable / pan</th><th>Adicionales</th><th></th>
    </tr></thead><tbody>
      ${b.productos.map((l, i) => {
        const sl = snap.lineas[i];
        const u = coCosteoUnitario(snap, sl, rc);
        const porPeso = coNum(l.gramosMasa) > 0;
        const piezas = Math.max(1, Math.round(coNum(l.piezas, 1)));
        const lnk = 'style="font-size:11px;color:var(--primary);cursor:pointer;text-decoration:underline"';
        const celdaMasa = porPeso
          ? `<div style="white-space:nowrap"><input type="text" inputmode="decimal" value="${String(l.gramosMasa).replace('.', ',')}" onchange="coCatSetGramos(${i},'gramosMasa',this.value)" style="width:64px" title="Gramos de masa cruda de la pieza"/> g
              ÷ <input type="number" min="1" step="1" value="${piezas}" onchange="coCatSetGramos(${i},'piezas',this.value)" style="width:48px" title="Partes en que se corta"/> partes</div>
             <div class="muted" style="font-size:11px">${piezas > 1 ? `${coN(l.gramosMasa / piezas, 1)} g c/u · ` : ''}= ${coN(l.bolitasPorPan, 4)} bolitas · <a ${lnk} onclick="coCatLineaModo(${i},'bolitas')">usar bolitas</a></div>`
          : `<input type="text" inputmode="decimal" value="${String(l.bolitasPorPan).replace('.', ',')}" onchange="coCatSetLinea(${i},'bolitasPorPan',this.value)" style="width:70px"/> bolitas
             <div class="muted" style="font-size:11px">${pesoBol ? `≈ ${coN(l.bolitasPorPan * pesoBol, 0)} g · ` : ''}<a ${lnk} onclick="coCatLineaModo(${i},'peso')">pasar a gramos</a></div>`;
        return `<tr>
          <td class="bold">${coEsc(sl.nombre)}${porPeso ? ' <span class="badge" style="font-size:10px">por peso</span>' : ''}</td>
          <td>${celdaMasa}</td>
          <td><input type="number" min="1" step="1" value="${l.panesPorLata ?? ''}" placeholder="—" onchange="coCatSetLinea(${i},'panesPorLata',this.value)" style="width:70px"/></td>
          <td class="num bold">${coM(u.variablePorPan)}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="coCatToggleLinea(${i})"><span class="ms">shopping_bag</span>${(l.adicionales || []).length}</button></td>
          <td><button class="btn btn-danger btn-sm" onclick="coCatDelLinea(${i})"><span class="ms">delete</span></button></td>
        </tr>
        ${_coCatAbierta === i ? `<tr><td colspan="6"style="background:var(--surface-container-low)">
          <div class="bold mb-sm" style="font-size:12.5px">Adicionales y empaques de ${coEsc(sl.nombre)}</div>
          ${coAdForm('cm-la', Object.entries(CO_BASES_AD).map(([k, t]) => `<option value="${k}">${t}</option>`).join(''),
            `onchange="$('#cm-la-gbox').style.display=this.value==='grupo'?'':'none'"`)}
          <div class="field" id="cm-la-gbox" style="display:none;max-width:200px"><label>N panes por grupo</label><input id="cm-la-grupo" type="number" min="1" step="1" placeholder="Ej: 10"/></div>
          <button class="btn btn-secondary btn-sm mb-sm" onclick="coCatAddAdLinea(${i})"><span class="ms">add</span>Agregar</button>
          ${coCatTablaAd(sl.adicionales, 'coCatDelAdLinea', i)}
          <div class="muted" style="font-size:11px">Por grupo de N: unidades = cantidad × ceil(panes ÷ N), redondeado por tipo de pan en cada registro (101 panes con 1 bolsa cada 10 → 11 bolsas).</div>
        </td></tr>` : ''}`;
      }).join('')}
    </tbody></table></div>`}

    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-family:var(--font-mono);font-size:13px;line-height:1.8">
      Bolitas por arroba: <b>${num(rc.bolitasPorArroba)}</b> (${coN(snap.parametros.pepasPorArroba)} pepas × ${coN(snap.parametros.bolitasPorPepa)})<br>
      Costo receta base (${coN(ab)} @): <b>${coM(rc.costoRecetaBase)}</b><br>
      Costo de masa por arroba: <b>${coM(rc.costoMasaPorArroba)}</b> · media arroba: <b>${coM(rc.costoMasaMediaArroba)}</b><br>
      Costo por bolita: <b>${coM2(rc.costoPorBolita)}</b>${pesoBol ? ` (1 bolita ≈ ${coN(pesoBol, 1)} g)` : ''}
      ${cxg != null ? `<br>Costo por gramo de masa: <b>$${coN(cxg, 2)}</b> · por kilo: <b>${money(cxg * 1000)}</b>` : ''}
      ${rc.motivos.length ? `<br><span style="color:var(--error)">⚠ Costeo incompleto: ${rc.motivos.map(coEsc).join(' · ')}</span>` : ''}
    </div></div>`;
  coAdMedida('cm-ad');
  coAdMedida('cm-la');
}

/**
 * Formulario de un adicional. Para insumos que se compran por unidad (huevos)
 * permite escribir la cantidad en GRAMOS de una unidad: 2 g de un huevo de
 * 50 g = 0,04 huevos. `pref` = prefijo de ids; `bases` = <option> de la base.
 */
function coAdForm(pref, bases, baseAttrs = '') {
  return `
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Insumo</label><select id="${pref}-ins" onchange="coAdMedida('${pref}')">${coOpcInsumos()}</select></div>
      <div class="field" id="${pref}-medbox" style="display:none"><label>Medir en</label>
        <select id="${pref}-med" onchange="coAdMedida('${pref}')">
          <option value="und">Unidades completas</option>
          <option value="g">Gramos (una parte de la unidad)</option></select></div>
      <div class="field" id="${pref}-gpubox" style="display:none"><label>¿Cuánto pesa 1 unidad? (g)</label>
        <input id="${pref}-gpu" type="text" inputmode="decimal" placeholder="Ej: 1 huevo ≈ 50"/></div>
    </div>
    <div class="gf3" style="align-items:end">
      <div class="field"><label id="${pref}-cantlbl">Cantidad</label><input id="${pref}-cant" type="text" inputmode="decimal" placeholder="Ej: 1 · 0,5 · 2"/></div>
      <div class="field"><label>Base</label><select id="${pref}-base" ${baseAttrs}>${bases}</select></div>
    </div>
    <div id="${pref}-hint" class="muted mb-sm" style="font-size:11px"></div>`;
}

/** Muestra u oculta "medir en gramos" según el insumo elegido y actualiza la etiqueta. */
function coAdMedida(pref) {
  const sel = $(`#${pref}-ins`);
  if (!sel) return;
  const ins = coInsumo(sel.value);
  const porUnidad = coBaseDe(ins?.unidadCompra) === 'und';
  const enGramos = porUnidad && $(`#${pref}-med`).value === 'g';
  $(`#${pref}-medbox`).style.display = porUnidad ? '' : 'none';
  $(`#${pref}-gpubox`).style.display = enGramos ? '' : 'none';
  const gpu = $(`#${pref}-gpu`);
  if (enGramos && !gpu.value) {
    // Reutiliza el peso por unidad que ya se haya usado para ese insumo.
    const todos = [..._coCatBuf.adicionales, ..._coCatBuf.productos.flatMap(l => l.adicionales || [])];
    const previo = todos.find(a => a.insumoId === sel.value && a.gramosPorUnidad);
    if (previo) gpu.value = String(previo.gramosPorUnidad).replace('.', ',');
  }
  $(`#${pref}-cantlbl`).textContent = ins?.esMezcla ? 'Gramos de mezcla'
    : enGramos ? 'Cantidad (gramos)' : `Cantidad (${ins ? coBaseLabel(ins.unidadCompra) : 'unidad base'})`;
  $(`#${pref}-hint`).textContent = ins?.esMezcla
    ? 'Mezcla general: escribe cuántos gramos de mezcla lleva y elige la base (normalmente "Por pan"). Solo se cobra a este tipo de pan.'
    : enGramos
    ? 'Ej: si 1 huevo pesa 50 g y cada pan lleva 2 g, escribe 50 arriba y 2 aquí → se cobra 0,04 huevos por pan.'
    : porUnidad ? 'Si usas solo una parte de la unidad (ej: unos gramos de huevo), elige "Medir en: Gramos".' : '';
}

/** Lee el formulario de un adicional. Devuelve null (con aviso) si algo falta. */
function coAdLeer(pref) {
  const insumoId = $(`#${pref}-ins`).value;
  const valor = coDec($(`#${pref}-cant`).value);
  if (!(valor > 0)) { toast('Cantidad inválida', 'error'); return null; }
  const enGramos = coBaseDe(coInsumo(insumoId)?.unidadCompra) === 'und' && $(`#${pref}-med`).value === 'g';
  if (!enGramos) return { insumoId, cantidad: valor, gramosPorUnidad: null };
  const gpu = coDec($(`#${pref}-gpu`).value);
  if (!(gpu > 0)) { toast('Indica cuántos gramos pesa 1 unidad', 'error'); return null; }
  return { insumoId, cantidad: valor / gpu, gramosPorUnidad: gpu };
}

function coCatTablaAd(lista, fnDel, linea) {
  if (!lista.length) return '<div class="muted mb-sm" style="font-size:12px">Sin adicionales.</div>';
  const arg = linea === null ? '' : `${linea},`;
  return `<div class="tw mb-sm"><table class="d"><thead><tr><th>Insumo</th><th>Cantidad</th><th>Base</th><th>Precio unitario</th><th>Costo</th><th></th></tr></thead><tbody>
    ${lista.map((a, j) => `<tr>
      <td class="bold">${coEsc(a.nombre)}</td>
      <td class="num">${coAdCantTxt(a)}</td>
      <td>${CO_BASES_AD[a.base] || a.base}${a.base === 'grupo' ? ` (N = ${a.grupo})` : ''}</td>
      <td class="num">${a.ok ? '$' + num(a.precioBase, 2) + '/' + a.unidad : `<span class="badge badge-warn">${coEsc(a.motivo)}</span>`}</td>
      <td class="num">${a.ok ? coM2(a.cantidad * a.precioBase) : '-'}</td>
      <td><button class="btn btn-danger btn-sm" onclick="${fnDel}(${arg}${j})"><span class="ms">delete</span></button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function coCatAddIng() {
  const insumoId = $('#cm-ins').value;
  const cantidad = coNum($('#cm-cant').value);
  if (cantidad <= 0) { toast('Cantidad inválida', 'error'); return; }
  const ex = _coCatBuf.ingredientes.find(x => x.insumoId === insumoId);
  if (ex) ex.cantidad = coNum(ex.cantidad) + cantidad;
  else _coCatBuf.ingredientes.push({ insumoId, cantidad });
  coCatCampos();
}
/** Toma la suma de ingredientes por arroba como peso de la masa. */
function coCatUsarSuma() {
  const s = coSumaIngArrobaG(_coCatBuf);
  if (!s) return;
  const el = $('#cm-pm');
  if (el) el.value = String(Math.round(s / 10) / 100).replace('.', ',');
  coCatCampos();
}
function coCatSetIng(i, v) { _coCatBuf.ingredientes[i].cantidad = coNum(v); coCatCampos(); }
function coCatDelIng(i) { _coCatBuf.ingredientes.splice(i, 1); coCatCampos(); }

function coCatAddAd() {
  const ad = coAdLeer('cm-ad');
  if (!ad) return;
  _coCatBuf.adicionales.push({ ...ad, base: $('#cm-ad-base').value });
  coCatCampos();
}
function coCatDelAd(j) { _coCatBuf.adicionales.splice(j, 1); coCatCampos(); }

/** Lee la masa por pan del formulario (bolitas o gramos ÷ partes). null con aviso si falta algo. */
function coCatLeerMasaForm() {
  if (_coLModo === 'peso') {
    const g = coCant($('#cm-lg')?.value);
    const n = Math.round(coDec($('#cm-lpz')?.value) || 1);
    if (!(g > 0)) { toast('Escribe los gramos de masa cruda de la pieza', 'error'); return null; }
    if (!(n >= 1)) { toast('Las partes deben ser 1 o más', 'error'); return null; }
    const pm = coDec($('#cm-pm')?.value);
    if (pm > 0) _coCatBuf.pesoMasaKg = pm;
    const bpp = coBppDeGramos(_coCatBuf, g, n);
    if (!bpp) { toast('Primero escribe el peso de la masa de 1 arroba (recuadro amarillo)', 'error'); $('#cm-pm')?.focus(); return null; }
    return { bolitasPorPan: bpp, gramosMasa: g, piezas: n };
  }
  const bpp = coLeerBpp($('#cm-lbpp')?.value);
  if (!bpp) { toast('Las bolitas por pan deben ser mayores a 0', 'error'); return null; }
  return { bolitasPorPan: bpp, gramosMasa: null, piezas: null };
}
/** Cambia cómo se arma el pan en el formulario (conserva el producto elegido). */
function coCatLModo(m) {
  const prod = $('#cm-prod')?.value, ppl = $('#cm-lppl')?.value;
  _coLModo = m;
  coCatCampos();
  if (prod && $('#cm-prod')) $('#cm-prod').value = prod;
  if (ppl && $('#cm-lppl')) $('#cm-lppl').value = ppl;
  if (m === 'peso') $('#cm-lg')?.focus();
}
/** Vista previa en vivo: gramos → bolitas y costo de masa por unidad. */
function coCatPrevPeso() {
  const el = $('#cm-lprev');
  if (!el) return;
  const g = coCant($('#cm-lg')?.value);
  const n = Math.max(1, Math.round(coDec($('#cm-lpz')?.value) || 1));
  if (!(g > 0)) { el.innerHTML = ''; return; }
  const b = _coCatBuf;
  const bpp = coBppDeGramos(b, g, n);
  if (!bpp) { el.innerHTML = '<span style="color:#8a5a00">Escribe arriba el peso de la masa de 1 arroba para calcular.</span>'; return; }
  const rc = coCosteoReceta(coSnapshotCategoria({ ...b, parametros: coParams(b.parametros) }));
  const masa = rc.costoPorBolita != null ? rc.costoPorBolita * bpp : null;
  el.innerHTML = `<div style="background:#eef6dc;border-radius:8px;padding:8px 12px">
    ${n > 1 ? `Pieza de <b>${coN(g, 1)} g</b> ÷ ${n} partes = <b>${coN(g / n, 1)} g</b> cada una → ` : `<b>${coN(g, 1)} g</b> → `}
    <b>${coN(bpp, 4)} bolitas</b> por unidad
    ${masa != null ? ` · masa: <b>${money(masa)}</b> por unidad${n > 1 ? ` (${money(masa * n)} la pieza entera)` : ''}` : ''}
    <div class="muted" style="font-size:11px">Los adicionales (relleno, bolsa…) se agregan después en el botón de la bolsa.</div></div>`;
}
/** Cambia los gramos o las partes de un pan armado por peso. */
function coCatSetGramos(i, k, v) {
  const l = _coCatBuf.productos[i];
  if (k === 'piezas') {
    const n = Math.round(coDec(v));
    if (!(n >= 1)) { toast('Las partes deben ser 1 o más', 'error'); coCatCampos(); return; }
    l.piezas = n;
  } else {
    const g = coCant(v);
    if (!(g > 0)) { toast('Los gramos deben ser mayores a 0', 'error'); coCatCampos(); return; }
    l.gramosMasa = g;
  }
  if (!coPesoBolitaG(_coCatBuf)) toast('Escribe el peso de la masa de 1 arroba para recalcular las bolitas', 'error');
  coCatCampos();
}
/** Pasa un pan ya asociado de bolitas a gramos o al revés (sin cambiar su costo). */
function coCatLineaModo(i, m) {
  const l = _coCatBuf.productos[i];
  if (m === 'peso') {
    const pb = coPesoBolitaG(_coCatBuf);
    if (!pb) { toast('Primero escribe el peso de la masa de 1 arroba (recuadro amarillo)', 'error'); $('#cm-pm')?.focus(); return; }
    l.gramosMasa = Math.round(coNum(l.bolitasPorPan) * pb);
    l.piezas = 1;
  } else {
    l.gramosMasa = null;
    l.piezas = null;
  }
  coCatCampos();
}

function coCatAddLinea() {
  const productoId = $('#cm-prod').value;
  if (!productoId) { toast('No hay productos disponibles para asociar', 'error'); return; }
  const masa = coCatLeerMasaForm();
  if (!masa) return;
  const ppl = coNum($('#cm-lppl').value);
  if (ppl && (ppl < 1 || Math.round(ppl) !== ppl)) { toast('Panes por lata debe ser un entero positivo', 'error'); return; }
  _coCatBuf.productos.push({ lineaId: appwriteService.genId('CML'), productoId, ...masa, panesPorLata: ppl || null, adicionales: [] });
  coCatCampos();
}
function coCatSetLinea(i, k, v) {
  const n = coNum(v);
  if (k === 'panesPorLata') _coCatBuf.productos[i].panesPorLata = n > 0 ? Math.round(n) : null;
  else {
    const bpp = coLeerBpp(v);
    if (bpp) _coCatBuf.productos[i][k] = bpp;
    else toast('Las bolitas por pan deben ser mayores a 0', 'error');
  }
  coCatCampos();
}
function coCatDelLinea(i) {
  const l = _coCatBuf.productos[i];
  if (_coCatBuf.repartoPredeterminado) delete _coCatBuf.repartoPredeterminado[l.lineaId];
  _coCatBuf.productos.splice(i, 1);
  _coCatAbierta = -1;
  coCatCampos();
}
function coCatToggleLinea(i) { _coCatAbierta = _coCatAbierta === i ? -1 : i; coCatCampos(); }
function coCatAddAdLinea(i) {
  const ad = coAdLeer('cm-la');
  if (!ad) return;
  const base = $('#cm-la-base').value;
  const grupo = Math.round(coNum($('#cm-la-grupo').value));
  if (base === 'grupo' && !(grupo >= 1)) { toast('Indica cuántos panes forman un grupo', 'error'); return; }
  (_coCatBuf.productos[i].adicionales ||= []).push({ ...ad, base, grupo: base === 'grupo' ? grupo : null });
  coCatCampos();
}
function coCatDelAdLinea(i, j) { _coCatBuf.productos[i].adicionales.splice(j, 1); coCatCampos(); }

async function coCatNuevoProducto() {
  const nombre = $('#cm-np-nombre').value.trim();
  const precio = coNum($('#cm-np-precio').value);
  if (!nombre) { toast('El producto necesita un nombre', 'error'); return; }
  if (!(precio > 0)) { toast('El precio de venta debe ser mayor a 0', 'error'); return; }
  const masa = coCatLeerMasaForm();
  if (!masa) return;
  try {
    const p = await appwriteService.guardarProducto({ nombre, precio, imagen: '' });
    saveDB();
    const ppl = coNum($('#cm-lppl').value);
    _coCatBuf.productos.push({ lineaId: appwriteService.genId('CML'), productoId: p.id, ...masa, panesPorLata: ppl > 0 ? Math.round(ppl) : null, adicionales: [] });
    toast(`Producto "${nombre}" creado en el catálogo`, 'success');
    coCatCampos();
  } catch (e) { /* el servicio ya mostró el error y no dejó copia local */ }
}

async function coGuardarCategoria() {
  coCatCampos();
  const b = _coCatBuf;
  if (!b.nombre) { toast('El nombre es obligatorio', 'error'); return; }
  if (!(coNum(b.arrobasBase) > 0)) { toast('La receta base debe ser una cantidad positiva de arrobas', 'error'); return; }
  try {
    await appwriteService.guardarCategoriaMasa(b);
    _coCatBuf = null;
    saveDB(); closeModal(); renderCostos(); toast('Categoría de masa guardada', 'success');
  } catch (e) { /* toast ya mostrado; el modal sigue abierto para corregir o reintentar */ }
}

/* ---------- Recetas antiguas por lata (histórico) ---------- */

function coTablaRecetasLegacy() {
  const recs = (DB.costos.recetas || []).filter(r => !coEsV2(r));
  if (!recs.length) return '<div class="empty">No hay recetas antiguas por lata.</div>';
  return `
    <div class="tw"><table class="d"><thead><tr>
      <th>Producto</th><th>Precio venta</th><th>Ingredientes</th><th>Costo / lata</th>
      <th>Panes / lata</th><th>Peso / pan</th><th>Costo / pan</th><th>Costo / kg</th><th></th>
    </tr></thead><tbody>
      ${recs.map(r => {
        const p = coProducto(r.productoId);
        const m = coMetricasProducto(r.productoId);
        return `<tr>
          <td class="bold">${coEsc(p?.nombre || '(producto eliminado)')} <span class="badge">lata_v1</span></td>
          <td class="num">${p ? money(p.precio) : '-'}</td>
          <td>${(r.ingredientes || []).length} insumo(s)${m.faltantes.length ? ` <span class="badge badge-error">${m.faltantes.length} faltante(s)</span>` : ''}</td>
          <td class="num bold">${money(m.costoLata)}</td>
          <td class="center">${num(m.panesPorLata)}</td>
          <td class="num">${num(m.pesoPorPan, 1)} g</td>
          <td class="num bold">${money(m.costoPorPan)}</td>
          <td class="num">${m.costoPorKg === 0 ? '-' : money(m.costoPorKg)}</td>
          <td>
            ${p ? `<button class="btn btn-ghost btn-sm" onclick="coRecetaModal('${r.productoId}')"><span class="ms">edit</span></button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="coDelReceta('${r.id}')"><span class="ms">delete</span></button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`;
}

function coRecetaModal(productoId) {
  const p = coProducto(productoId);
  if (!p) return;
  const r = coReceta(productoId);
  _coRecetaBuf = r ? JSON.parse(JSON.stringify(r.ingredientes || [])) : [];

  if (!(DB.costos.insumos || []).length) {
    toast('Primero registra al menos un insumo', 'error');
    return;
  }

  modal(`Receta antigua (por lata) · ${coEsc(p.nombre)}`, `
    <div class="muted mb-md" style="font-size:12px">Histórico: solo afecta registros antiguos por lata que no tengan costo congelado. La producción nueva usa categorías de masa.</div>
    <div class="gf">
      <div class="field"><label>Panes por lata *</label>
        <input id="cr-ppl" type="number" min="1" step="1" value="${r?.panesPorLata || 1}" oninput="coRecetaTotales()"/></div>
      <div class="field"><label>Peso por pan (gramos) *</label>
        <input id="cr-ppp" type="number" step="any" value="${r?.pesoPorPan || ''}" placeholder="Ej: 80" oninput="coRecetaTotales()"/></div>
    </div>
    <h3 class="mt-md mb-sm">Ingredientes de UNA lata</h3>
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Insumo</label>
        <select id="cr-ins">${DB.costos.insumos.map(i => `<option value="${i.id}">${coEsc(i.nombre)} ($${num(i.precioBase, 4)}/${coBaseLabel(i.unidadCompra)})</option>`).join('')}</select></div>
      <div class="field"><label>Cantidad (en unidad base)</label>
        <input id="cr-cant" type="number" step="any" placeholder="Ej: 1000"/></div>
      <button class="btn btn-secondary" onclick="coAddIngrediente()"><span class="ms">add</span>Agregar</button>
    </div>
    <div id="cr-lista" class="mt-md"></div>
    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b">
      <div id="cr-totales" style="font-family:var(--font-mono);font-size:13px"></div>
    </div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarReceta('${productoId}')">Guardar receta</button>`, 'lg');

  coRecetaTotales();
}

function coAddIngrediente() {
  const insumoId = $('#cr-ins').value;
  const cantidad = coNum($('#cr-cant').value);
  if (cantidad <= 0) { toast('Cantidad inválida', 'error'); return; }
  const existente = _coRecetaBuf.find(x => x.insumoId === insumoId);
  if (existente) existente.cantidad = coNum(existente.cantidad) + cantidad;
  else _coRecetaBuf.push({ insumoId, cantidad });
  $('#cr-cant').value = '';
  coRecetaTotales();
}
function coDelIngrediente(i) { _coRecetaBuf.splice(i, 1); coRecetaTotales(); }
function coSetIngrediente(i, val) { _coRecetaBuf[i].cantidad = coNum(val); coRecetaTotales(); }

/** Repinta la lista de ingredientes y los totales derivados del modal antiguo. */
function coRecetaTotales() {
  const ppl = Math.max(1, coNum($('#cr-ppl')?.value, 1));
  const ppp = coNum($('#cr-ppp')?.value);

  const lista = $('#cr-lista');
  if (lista) {
    lista.innerHTML = _coRecetaBuf.length === 0
      ? '<div class="empty">Sin ingredientes todavía.</div>'
      : `<div class="tw"><table class="d"><thead><tr>
          <th>Insumo</th><th>Cantidad</th><th>Precio unitario</th><th>Costo</th><th></th>
        </tr></thead><tbody>
          ${_coRecetaBuf.map((g, i) => {
            const ins = coInsumo(g.insumoId);
            if (!ins) return `<tr><td colspan="5" style="color:var(--error)">Insumo eliminado — <button class="btn btn-danger btn-sm" onclick="coDelIngrediente(${i})">Quitar</button></td></tr>`;
            const base = coBaseLabel(ins.unidadCompra);
            const costo = coNum(g.cantidad) * coNum(ins.precioBase);
            return `<tr>
              <td class="bold">${coEsc(ins.nombre)}</td>
              <td><input type="number" step="any" value="${g.cantidad}" onchange="coSetIngrediente(${i},this.value)" style="width:110px"/> <span class="muted">${base}</span></td>
              <td class="num">$${num(ins.precioBase, 4)}</td>
              <td class="num bold">${money(costo)}</td>
              <td><button class="btn btn-danger btn-sm" onclick="coDelIngrediente(${i})"><span class="ms">delete</span></button></td>
            </tr>`;
          }).join('')}
        </tbody></table></div>`;
  }

  const costoLata = _coRecetaBuf.reduce((a, g) => {
    const ins = coInsumo(g.insumoId);
    return a + (ins ? coNum(g.cantidad) * coNum(ins.precioBase) : 0);
  }, 0);
  const pesoLata = ppl * ppp;
  const tot = $('#cr-totales');
  if (tot) {
    tot.innerHTML = `
      Costo de la lata: <b>${money(costoLata)}</b><br>
      Costo por pan: <b>${money(ppl > 0 ? costoLata / ppl : 0)}</b><br>
      Peso de la lata: <b>${num(pesoLata, 0)} g (${num(pesoLata / 1000, 2)} kg)</b><br>
      Costo por kilogramo: <b>${pesoLata > 0 ? money(costoLata / (pesoLata / 1000)) : '—'}</b><br>
      Costo por gramo: <b>${pesoLata > 0 ? '$' + num(costoLata / pesoLata, 3) : '—'}</b>`;
  }
}

async function coGuardarReceta(productoId) {
  const panesPorLata = Math.max(1, Math.round(coNum($('#cr-ppl').value, 1)));
  const pesoPorPan = coNum($('#cr-ppp').value);
  if (pesoPorPan <= 0) { toast('El peso por pan debe ser mayor a 0', 'error'); return; }
  if (!_coRecetaBuf.length) { toast('Agrega al menos un ingrediente', 'error'); return; }

  const r = coReceta(productoId);
  try {
    await appwriteService.guardarReceta({
      ...(r ? { id: r.id } : {}),
      modelo: CO_MODELO.LATA,
      productoId, panesPorLata, pesoPorPan,
      ingredientes: _coRecetaBuf.map(g => ({ insumoId: g.insumoId, cantidad: coNum(g.cantidad) }))
    });
    saveDB(); closeModal(); renderCostos(); toast('Receta guardada', 'success');
  } catch (e) { /* toast ya mostrado */ }
}

function coDelReceta(id) {
  modal('Eliminar receta antigua', '<p>Los registros por lata que ya tienen costo congelado no cambian. Los que no lo tengan quedarán sin costo de respaldo.</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelRecetaOk('${id}')">Eliminar</button>`);
}
async function coDelRecetaOk(id) {
  try { await appwriteService.eliminarReceta(id); saveDB(); closeModal(); renderCostos(); toast('Receta eliminada', 'success'); }
  catch (e) { /* toast ya mostrado */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 4 · PRODUCCIÓN (libras o arrobas)
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabProduccion(d) {
  const lotes = d.lotes.slice().sort((a, b) => String(a.registro.creado || '').localeCompare(String(b.registro.creado || '')));
  return `
    <div class="flex gap mb-md" style="flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" onclick="coProdModal()"><span class="ms">add</span>Registrar producción</button>
      <span class="muted" style="font-size:12px">Producción del ${_coFecha}</span>
    </div>
    <div class="grid grid-4 mb-md">
      ${coKpi('Arrobas', coN(d.arrobas), 'scale', 'kpi-ico-s', `${coN(d.libras, 1)} lb · ref. ${coN(d.pesoRefKg, 1)} kg`)}
      ${coKpi('Bolitas', coN(d.bolitas, 1), 'bubble_chart', 'kpi-ico-p', `${coN(d.pepas, 2)} pepas`)}
      ${coKpi('Panes confirmados', num(d.panesConfirmados), 'task_alt', 'kpi-ico-t', `${num(d.panesEstimados)} estimados sin confirmar`)}
      ${coKpi('Costo de masa', d.costeoIncompleto ? CO_INCOMPLETO : money(d.costoMasa), 'bakery_dining', 'kpi-ico-e', `Adicionales: ${d.costeoIncompleto ? '—' : money(d.costoAdicionales)}`)}
    </div>
    ${lotes.length === 0 ? '<div class="empty">Sin producción por arroba registrada este día.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Categoría</th><th>Cantidad</th><th>Arrobas</th><th>Bolitas</th><th>Estado</th>
      <th>Panes</th><th>Latas (info.)</th><th>Masa</th><th>Adicionales</th><th>Total lote</th><th></th>
    </tr></thead><tbody>
      ${lotes.map(({ registro: r, res }) => {
        const est = CO_ESTADOS[res.estado];
        const panesTxt = res.estado === 'pendiente' ? '<span class="muted">Sin reparto</span>'
          : res.estado === 'confirmado' ? `<b>${num(res.panesConfirmados)}</b> <span class="muted">reales</span>`
          : `${num(res.panesEstimados)} <span class="muted">estim.</span>`;
        return `<tr>
          <td class="bold">${coEsc(r.categoriaNombre || r.snapshot?.nombre || '-')}</td>
          <td class="num">${coN(r.cantidad)} ${r.unidad === 'lb' ? 'lb' : '@'}</td>
          <td class="num">${coN(res.arrobas, 3)}</td>
          <td class="num">${coN(res.bolitas, 1)}</td>
          <td><span class="badge ${est.c}">${est.t}</span>${res.completo ? '' : ' ' + CO_INCOMPLETO}</td>
          <td class="num">${panesTxt}</td>
          <td class="num">${res.reparto.length ? (res.lineasSinLatas === res.reparto.length ? '<span class="muted">Sin config.</span>' : coN(res.latasEquivalentes, 1)) : '-'}</td>
          <td class="num">${coM(res.costoMasaLote)}</td>
          <td class="num">${coM(res.costoAdicionales)}</td>
          <td class="num bold">${coM(res.costoTotalLote)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-ghost btn-sm" title="Ver detalle" onclick="coProdDetalle('${r.id}')"><span class="ms">visibility</span></button>
            <button class="btn btn-ghost btn-sm" title="${res.estado === 'pendiente' ? 'Completar reparto' : 'Editar reparto'}" onclick="coProdModal('${r.id}')"><span class="ms">${res.estado === 'pendiente' ? 'call_split' : 'edit'}</span></button>
            ${res.estado !== 'pendiente' ? `<button class="btn btn-ghost btn-sm" title="Confirmar conteo real" onclick="coConfirmarModal('${r.id}')"><span class="ms">task_alt</span></button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="coDelProd('${r.id}')"><span class="ms">delete</span></button>
          </td>
        </tr>`;
      }).join('')}
      <tr style="background:var(--surface-container-low)" class="bold">
        <td>TOTAL</td><td></td><td class="num">${coN(d.arrobas, 3)}</td><td class="num">${coN(d.bolitas, 1)}</td><td></td>
        <td class="num">${num(d.panesConfirmados)} reales · ${num(d.panesEstimados)} estim.</td>
        <td class="num">${coN(d.latasEq, 1)}</td>
        <td class="num">${d.costeoIncompleto ? '—' : money(d.costoMasa)}</td>
        <td class="num">${d.costeoIncompleto ? '—' : money(d.costoAdicionales)}</td>
        <td class="num">${d.costeoIncompleto ? CO_INCOMPLETO : money(d.costoMasa + d.costoAdicionales)}</td><td></td>
      </tr>
    </tbody></table></div>`}
    ${d.porProducto.length ? `
    <h3 class="mt-lg mb-md">Registros antiguos por lata (cálculo histórico)</h3>
    <div class="tw"><table class="d"><thead><tr>
      <th>Producto</th><th>Latas</th><th>Panes/lata</th><th>Peso/pan</th><th>Total panes</th>
      <th>Peso total</th><th>Costo/lata</th><th>Costo/pan</th><th>Costo total</th><th></th>
    </tr></thead><tbody>
      ${d.porProducto.map(r => `<tr>
        <td class="bold">${coEsc(r.nombre)} <span class="badge">lata_v1</span></td>
        <td class="num">${num(r.latas, 1)}</td>
        <td class="center">${num(r.panesPorLata)}</td>
        <td class="num">${num(r.pesoPorPan, 1)} g</td>
        <td class="num bold">${num(r.panes)}</td>
        <td class="num">${num(r.pesoKg, 2)} kg</td>
        <td class="num">${money(r.costoLata)}</td>
        <td class="num">${money(r.costoPorPan)}</td>
        <td class="num bold">${money(r.costoTotal)}</td>
        <td><button class="btn btn-danger btn-sm" onclick="coDelProd('${r.registroId}')"><span class="ms">delete</span></button></td>
      </tr>`).join('')}
      <tr style="background:var(--surface-container-low)" class="bold">
        <td>TOTAL</td><td class="num">${num(d.latas, 1)}</td><td></td><td></td>
        <td class="num">${num(d.panesLata)}</td><td class="num">${num(d.pesoKg, 2)} kg</td>
        <td></td><td></td><td class="num">${money(d.costoLata)}</td><td></td>
      </tr>
    </tbody></table></div>` : ''}`;
}

/** Unidades en que se manda a hacer un pan ('latas' solo si el pan tiene panes por lata). */
const CO_UNI_PROD = { lb: 'Libras', arroba: 'Arrobas', panes: 'Panes', latas: 'Latas' };

/**
 * Abre el registro de producción. Nuevo: una fila por cada tipo de pan de las
 * masas activas; se escribe cuánto se manda a hacer de cada uno (libras,
 * arrobas, panes o latas) y el sistema calcula arrobas, bolitas, panes, latas
 * y costo. Al guardar se crea un registro por masa usada, con ids de borrador
 * estables (reintentar tras un fallo no crea duplicados). Con id: corrige el
 * MISMO registro usando su fotografía congelada.
 */
function coProdModal(id) {
  let r = null;
  if (id) {
    r = (DB.costos.produccion || []).find(x => x.id === id);
    if (!r || !coEsV2(r)) return;
  }
  const cats = coCategorias().filter(c => c.activo !== false && (c.productos || []).length);
  if (!r && !cats.length) {
    toast('No hay categorías de masa activas con tipos de pan. Créalas en "Masas y recetas".', 'error');
    return;
  }

  _coProd = r
    ? { nuevo: false, grupos: [{ id: r.id, categoriaId: r.categoriaId, snapshot: r.snapshot }] }
    : { nuevo: true, grupos: cats.map(c => ({ id: appwriteService.genId('PR'), categoriaId: c.id, snapshot: coSnapshotCategoria(c) })) };

  // Al editar se muestra lo que se escribió; los registros anteriores a este
  // formulario solo tienen bolitas, que se muestran convertidas a libras.
  const inicial = (g, l) => {
    const e = (r?.reparto || []).find(x => x.lineaId === l.lineaId);
    if (!e) return { cantidad: '', unidad: 'lb' };
    if (e.unidadIngresada) return { cantidad: e.cantidadIngresada, unidad: e.unidadIngresada };
    const p = coParams(g.snapshot.parametros);
    const lb = coNum(e.bolitasAsignadas) / (p.pepasPorArroba * p.bolitasPorPepa) * p.librasPorArroba;
    return { cantidad: Math.round(lb * 100) / 100, unidad: 'lb' };
  };

  modal(r ? `Producción · ${coEsc(r.categoriaNombre || r.snapshot?.nombre)}` : 'Registrar producción', `
    <div class="gf">
      <div class="field"><label>Fecha</label><input id="cp-fecha" type="date" value="${r ? r.fecha : _coFecha}"/></div>
    </div>
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px;line-height:1.6">
      <b>¿Cómo se llena?</b> Escribe cuánto mandas a hacer de cada pan y elige cómo lo mides:
      <b>libras</b>, <b>arrobas</b>, <b>panes</b> (cantidad de unidades) o <b>latas</b>.
      Deja en blanco los panes que no hagas. El sistema calcula solo la masa, las arrobas, los panes, las latas y el costo.
    </div></div>
    ${r ? `<div class="muted mb-sm" style="font-size:11.5px">Se usan la receta, los precios y la configuración congelados el ${new Date(r.snapshot.tomadoEn).toLocaleString('es-CO')}.
      La masa total se recalcula con lo que escribas aquí (registro actual: ${coN(r.cantidad)} ${r.unidad === 'lb' ? 'lb' : '@'}).${r.confirmado ? ' <b>Guardar quita la confirmación del conteo.</b>' : ''}</div>` : ''}
    ${_coProd.grupos.map((g, gi) => coProdTablaGrupo(g, gi, inicial)).join('')}
    <div id="cp-tot"></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" id="cp-guardar" onclick="coGuardarProd()">${r ? 'Guardar cambios' : 'Registrar'}</button>`, 'lg');

  coProdRecalc();
}

/** Tabla de una masa: una fila por tipo de pan con su cantidad y unidad. */
function coProdTablaGrupo(g, gi, inicial) {
  const snap = g.snapshot;
  const p = coParams(snap.parametros);
  const dec = (v) => (v === '' || v == null ? '' : String(v).replace('.', ','));
  return `
    <h3 class="mt-md mb-sm">${coEsc(snap.nombre)} <span class="muted" style="font-size:12px;font-weight:400">· 1 arroba = ${coN(p.librasPorArroba)} lb = ${num(p.pepasPorArroba * p.bolitasPorPepa)} bolitas</span></h3>
    <div class="tw"><table class="d"><thead><tr>
      <th>Pan</th><th>¿Cuánto vas a hacer?</th><th>Medido en</th><th>Panes</th><th>Masa</th><th>Latas</th><th>Costo</th>
    </tr></thead><tbody>
      ${snap.lineas.map((l, li) => {
        const v = inicial(g, l);
        return `<tr>
          <td class="bold">${coEsc(l.nombre)}<div class="muted" style="font-size:11px;font-weight:400">${coN(l.bolitasPorPan, 4)} bolita(s) por pan${l.panesPorLata ? ` · ${num(l.panesPorLata)} panes por lata` : ''}</div></td>
          <td><input id="cp-q-${gi}-${li}" type="text" inputmode="decimal" value="${dec(v.cantidad)}" placeholder="0" oninput="coProdRecalc()" style="width:90px"/></td>
          <td><select id="cp-u-${gi}-${li}" onchange="coProdRecalc()">
            ${Object.entries(CO_UNI_PROD).filter(([k]) => k !== 'latas' || l.panesPorLata)
              .map(([k, t]) => `<option value="${k}" ${k === v.unidad ? 'selected' : ''}>${t}</option>`).join('')}
          </select></td>
          <td class="num bold" id="cp-p-${gi}-${li}">-</td>
          <td class="num" id="cp-m-${gi}-${li}">-</td>
          <td class="num" id="cp-l-${gi}-${li}">-</td>
          <td class="num" id="cp-k-${gi}-${li}">-</td>
        </tr>`;
      }).join('')}
      <tr class="bold" style="background:var(--surface-container-low)">
        <td colspan="3">Subtotal ${coEsc(snap.nombre)}</td>
        <td class="num" id="cp-sp-${gi}">-</td><td class="num" id="cp-sm-${gi}">-</td>
        <td class="num" id="cp-sl-${gi}">-</td><td class="num" id="cp-sk-${gi}">-</td>
      </tr>
    </tbody></table></div>`;
}

/**
 * Lo escrito para una masa → entradas del reparto y cantidad total del
 * registro. null si no se hace nada de esa masa.
 */
function coProdCalcGrupo(gi) {
  const snap = _coProd.grupos[gi].snapshot;
  const p = coParams(snap.parametros);
  const entradas = [];
  const sumas = { lb: 0, arroba: 0 };
  const usadas = new Set();
  let bolitas = 0;
  snap.lineas.forEach((l, li) => {
    const c = coDec($(`#cp-q-${gi}-${li}`)?.value);
    const unidad = $(`#cp-u-${gi}-${li}`)?.value;
    if (!(c > 0)) return;
    const b = coBolitasDe(c, unidad, l, snap.parametros);
    if (!(b > 0)) return;
    entradas.push({ lineaId: l.lineaId, productoId: l.productoId, bolitasAsignadas: b, cantidadIngresada: c, unidadIngresada: unidad });
    bolitas += b;
    usadas.add(unidad);
    if (unidad in sumas) sumas[unidad] += c;
  });
  if (!entradas.length) return null;
  // Si todo se pidió en libras (o todo en arrobas) el registro conserva esa unidad.
  const unica = usadas.size === 1 ? [...usadas][0] : null;
  const unidad = unica === 'lb' ? 'lb' : 'arroba';
  const cantidad = unica === 'lb' || unica === 'arroba' ? sumas[unica] : bolitas / (p.pepasPorArroba * p.bolitasPorPepa);
  return { cantidad, unidad, entradas, res: coCalcularLote(snap, cantidad, unidad, entradas, { confirmado: false }) };
}

/** Recalcula las columnas calculadas, los subtotales y el total del día. */
function coProdRecalc() {
  if (!_coProd) return;
  const set = (id, html) => { const el = $(`#${id}`); if (el) el.innerHTML = html; };
  const t = { libras: 0, arrobas: 0, panes: 0, costo: 0, incompleto: false, masas: 0, motivos: [] };

  _coProd.grupos.forEach((g, gi) => {
    const snap = g.snapshot;
    const lpa = coParams(snap.parametros).librasPorArroba;
    const res = coProdCalcGrupo(gi)?.res;
    snap.lineas.forEach((l, li) => {
      const r = res?.reparto.find(x => x.lineaId === l.lineaId);
      set(`cp-p-${gi}-${li}`, r ? num(r.panesEstimados) : '-');
      set(`cp-m-${gi}-${li}`, r ? `${coN(r.arrobasAsignadas * lpa, 2)} lb <div class="muted" style="font-size:11px">${coN(r.arrobasAsignadas, 3)} @</div>` : '-');
      set(`cp-l-${gi}-${li}`, !r ? '-' : !r.latas ? '<span class="muted">—</span>'
        : `${num(r.latas.necesarias)}${r.latas.panesUltimaLata !== r.latas.panesPorLata ? `<div class="muted" style="font-size:11px">última con ${num(r.latas.panesUltimaLata)}</div>` : ''}`);
      set(`cp-k-${gi}-${li}`, r ? `${coM(r.costoTotal)}${r.costoPorPan != null ? `<div class="muted" style="font-size:11px">${coM2(r.costoPorPan)} c/u</div>` : ''}` : '-');
    });
    const latas = res ? res.reparto.reduce((a, x) => a + (x.latas?.necesarias || 0), 0) : 0;
    set(`cp-sp-${gi}`, res ? num(res.panesEstimados) : '-');
    set(`cp-sm-${gi}`, res ? `${coN(res.libras, 2)} lb <div class="muted" style="font-size:11px">${coN(res.arrobas, 3)} @</div>` : '-');
    set(`cp-sl-${gi}`, latas ? num(latas) : '-');
    set(`cp-sk-${gi}`, res ? coM(res.costoTotalLote) : '-');
    if (!res) return;
    t.masas++;
    t.libras += res.libras;
    t.arrobas += res.arrobas;
    t.panes += res.panesEstimados;
    if (res.costoTotalLote == null) t.incompleto = true; else t.costo += res.costoTotalLote;
    t.motivos.push(...res.motivos.map(m => `${snap.nombre}: ${m}`));
  });

  set('cp-tot', `<div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:13.5px;line-height:1.9">
    ${t.masas === 0 ? '<span class="muted">Escribe la cantidad de al menos un pan para ver el cálculo.</span>' : `
      <b>Total a producir:</b> ${coN(t.libras, 2)} lb = <b>${coN(t.arrobas, 3)} arrobas</b> de masa · <b>${num(t.panes)} panes</b> estimados<br>
      <b>Costo total:</b> ${t.incompleto ? CO_INCOMPLETO : `<b>${money(t.costo)}</b>`}${!t.incompleto && t.panes > 0 ? ` <span class="muted">· promedio ${coM2(t.costo / t.panes)} por pan</span>` : ''}
      ${t.motivos.length ? `<br><span style="color:var(--error);font-size:12px">⚠ Costeo incompleto: ${[...new Set(t.motivos)].map(coEsc).join(' · ')}</span>` : ''}`}
  </div></div>`);
  const btn = $('#cp-guardar');
  if (btn && _coProd.nuevo) btn.textContent = t.masas > 1 ? `Registrar (${t.masas} masas)` : 'Registrar';
}

async function coGuardarProd() {
  if (!_coProd) return;
  const fecha = $('#cp-fecha')?.value || todayKey();
  const lotes = _coProd.grupos.map((g, gi) => ({ g, calc: coProdCalcGrupo(gi) })).filter(x => x.calc);
  if (!lotes.length) { toast('Escribe cuánto vas a hacer de al menos un pan', 'error'); return; }

  const btn = $('#cp-guardar');
  if (btn) btn.disabled = true;
  try {
    for (const { g, calc } of lotes) {
      await appwriteService.guardarProduccion({
        id: g.id,
        modelo: CO_MODELO.ARROBA,
        fecha,
        categoriaId: g.categoriaId,
        categoriaNombre: g.snapshot.nombre,
        cantidad: calc.cantidad, unidad: calc.unidad,
        reparto: calc.entradas,
        confirmado: false,
        estado: calc.res.estado,
        snapshot: g.snapshot,
        resultado: calc.res
      });
    }
  } catch (e) {
    // El servicio ya mostró el error. Cada masa conserva su id de borrador:
    // reintentar reemplaza las que sí se guardaron, no las duplica.
    if (btn) btn.disabled = false;
    return;
  }
  _coProd = null;
  saveDB(); closeModal(); renderCostos();
  toast(lotes.length > 1 ? `Producción guardada (${lotes.length} masas)` : 'Producción guardada', 'success');
}

function coConfirmarModal(id) {
  const r = (DB.costos.produccion || []).find(x => x.id === id);
  if (!r || !coEsV2(r)) return;
  const res = coResultadoDe(r);
  if (!res.reparto.length) { toast('Primero completa el reparto del lote', 'error'); return; }
  modal(`Confirmar conteo real · ${coEsc(r.categoriaNombre)}`, `
    <div class="muted mb-md" style="font-size:12px">Ingresa los panes que realmente salieron. La fórmula es solo una estimación; aquí registras la <b>producción real confirmada</b>.
      El costo de la masa no cambia; los empaques por pan o por grupo se recalculan con el conteo real.</div>
    <div class="tw"><table class="d"><thead><tr><th>Tipo de pan</th><th>Estimado</th><th>Real contado</th></tr></thead><tbody>
      ${res.reparto.map(l => `<tr>
        <td class="bold">${coEsc(l.nombre)}</td>
        <td class="num">${num(l.panesEstimados)}</td>
        <td><input id="cf-${l.lineaId}" type="number" min="0" step="1" value="${l.panesConfirmados ?? l.panesEstimados}" style="width:100px"/></td>
      </tr>`).join('')}
    </tbody></table></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarConfirmacion('${id}')">Confirmar conteo</button>`);
}

async function coGuardarConfirmacion(id) {
  const r = (DB.costos.produccion || []).find(x => x.id === id);
  if (!r) return;
  const reparto = (r.reparto || []).map(e => {
    const v = $(`#cf-${e.lineaId}`)?.value;
    return { ...e, panesConfirmados: v === '' || v === undefined ? null : Math.max(0, Math.round(coNum(v))) };
  });
  if (reparto.some(e => e.panesConfirmados == null)) { toast('Ingresa el conteo de todos los tipos de pan', 'error'); return; }
  const resultado = coCalcularLote(r.snapshot, r.cantidad, r.unidad, reparto, { confirmado: true });
  try {
    await appwriteService.guardarProduccion({
      id, modelo: CO_MODELO.ARROBA, categoriaId: r.categoriaId, cantidad: r.cantidad, unidad: r.unidad,
      snapshot: r.snapshot, reparto, confirmado: true, estado: resultado.estado, resultado
    });
    saveDB(); closeModal(); renderCostos(); toast('Conteo real confirmado', 'success');
  } catch (e) { /* toast ya mostrado */ }
}

function coProdDetalle(id) {
  const r = (DB.costos.produccion || []).find(x => x.id === id);
  if (!r || !coEsV2(r)) return;
  const res = coResultadoDe(r);
  const snap = r.snapshot;
  const p = res.parametros;
  const suma = (res.reparto.reduce((a, l) => a + (l.costoMasa ?? 0), 0)) + (res.costoSinAsignar ?? 0);
  modal(`Detalle · ${coEsc(r.categoriaNombre)} · ${r.fecha}`, `
    <div class="flex gap mb-md" style="flex-wrap:wrap">
      <span class="badge ${CO_ESTADOS[res.estado].c}">${CO_ESTADOS[res.estado].t}</span>
      <span class="badge">Modelo ${r.modelo} · v${r.version || 2}</span>
      <span class="badge">Fotografía: ${new Date(snap.tomadoEn).toLocaleString('es-CO')}</span>
    </div>
    <div style="font-family:var(--font-mono);font-size:12.5px;line-height:1.8" class="mb-md">
      Ingresado: <b>${coN(r.cantidad)} ${r.unidad === 'lb' ? 'libras' : 'arrobas'}</b> → ${coN(res.arrobas, 4)} arrobas · ${coN(res.libras, 2)} lb · ~${coN(res.pesoRefKg, 2)} kg (referencia)<br>
      Parámetros: ${p.librasPorArroba} lb/@ · ${p.kgRefPorArroba} kg ref/@ · ${p.pepasPorArroba} pepas/@ · Pique: ${p.bolitasPorPepa} bolitas por pepa<br>
      Pepas: ${coN(res.pepas, 2)} · Bolitas: ${coN(res.bolitas, 2)}<br>
      Receta base ${coN(res.arrobasBase)} @: ${coM(res.costoRecetaBase)} → masa/@ ${coM(res.costoMasaPorArroba)} → bolita ${coM2(res.costoPorBolita)}
    </div>
    <h3 class="mb-sm">Ingredientes aplicados (precios congelados)</h3>
    <div class="tw mb-md"><table class="d"><thead><tr><th>Insumo</th><th>Cantidad receta</th><th>Precio</th><th>Costo receta</th></tr></thead><tbody>
      ${snap.ingredientes.map(g => `<tr><td>${coEsc(g.nombre)}</td><td class="num">${coN(g.cantidad)} ${g.unidad}</td>
        <td class="num">${g.ok ? '$' + num(g.precioBase, 4) : `<span class="badge badge-warn">${coEsc(g.motivo)}</span>`}</td>
        <td class="num">${g.ok ? money(g.cantidad * g.precioBase) : '-'}</td></tr>`).join('')}
    </tbody></table></div>
    ${res.reparto.length ? `<h3 class="mb-sm">Reparto</h3>
    <div class="tw mb-md"><table class="d"><thead><tr><th>Pan</th><th>Bolitas</th><th>Bol./pan</th><th>Estimados</th><th>Reales</th><th>Remanente</th><th>Latas</th><th>Masa</th><th>Adicionales</th><th>Parte masa-cat.</th><th>Total</th><th>Por pan</th></tr></thead><tbody>
      ${res.reparto.map(l => `<tr>
        <td class="bold">${coEsc(l.nombre)}</td><td class="num">${coN(l.bolitasAsignadas, 2)}</td><td class="center">${coN(l.bolitasPorPan, 4)}</td>
        <td class="num">${num(l.panesEstimados)}</td><td class="num">${l.panesConfirmados == null ? '-' : num(l.panesConfirmados)}</td>
        <td class="num">${coN(l.bolitasRemanentes, 2)}</td>
        <td>${l.latas ? `${l.latas.necesarias} (${l.latas.completas} completas, última ${coN(l.latas.panesUltimaLata)})` : 'Sin configuración de latas'}</td>
        <td class="num">${coM(l.costoMasa)}</td><td class="num">${coM(l.costoAdicionales)}</td><td class="num">${coM(l.costoAdCategoria)}</td>
        <td class="num bold">${coM(l.costoTotal)}</td><td class="num">${coM(l.costoPorPan)}</td>
      </tr>
      ${l.adicionales.length ? `<tr><td></td><td colspan="11" class="muted" style="font-size:11.5px">${l.adicionales.map(a =>
        `${coEsc(a.nombre)}: ${coAdCantTxt(a, a.unidades)} (${CO_BASES_AD[a.base]}${a.base === 'grupo' ? ' N=' + a.grupo : ''}) = ${coM(a.costo)}`).join(' · ')}</td></tr>` : ''}`).join('')}
    </tbody></table></div>` : '<div class="empty mb-md">Pendiente de reparto: aún no hay panes asignados.</div>'}
    ${res.adicionalesCategoria.length ? `<div class="mb-md" style="font-size:12.5px"><b>Adicionales de la masa (una vez):</b> ${res.adicionalesCategoria.map(a => `${coEsc(a.nombre)} ${coAdCantTxt(a, a.unidades)} =${coM(a.costo)}`).join(' · ')}</div>` : ''}
    <div class="card" style="background:var(--surface-container-low)"><div class="card-b" style="font-family:var(--font-mono);font-size:12.5px;line-height:1.8">
      Conciliación de masa: asignada a panes y remanentes + sin asignar = <b>${res.costoMasaLote == null ? CO_INCOMPLETO : money(suma)}</b> · costo de masa del lote = <b>${coM(res.costoMasaLote)}</b><br>
      Adicionales: productos ${coM(res.costoAdicionalesProductos)} + masa ${coM(res.costoAdicionalesCategoria)} = <b>${coM(res.costoAdicionales)}</b><br>
      Costo total del lote: <b>${coM(res.costoTotalLote)}</b>
      ${res.motivos.length ? `<br><span style="color:var(--error)">⚠ ${res.motivos.map(coEsc).join(' · ')}</span>` : ''}
    </div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cerrar</button>`, 'lg');
}

function coDelProd(id) {
  modal('Eliminar registro', '<p>Se eliminará este registro de producción y su costo dejará de contar en el día.</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelProdOk('${id}')">Eliminar</button>`);
}
async function coDelProdOk(id) {
  try { await appwriteService.eliminarProduccion(id); saveDB(); closeModal(); renderCostos(); toast('Registro eliminado', 'success'); }
  catch (e) { /* toast ya mostrado; el registro volvió a la lista */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 5 · COSTOS INDIRECTOS
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabIndirectos() {
  const lista = (DB.costos.indirectos || []).slice().sort((a, b) => (a.categoria || '').localeCompare(b.categoria || ''));
  const totalDia = coIndirectoDiario();

  return `
    <div class="flex gap mb-md" style="flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" onclick="coIndModal()"><span class="ms">add</span>Nuevo costo indirecto</button>
    </div>
    <div class="grid grid-4 mb-md">
      ${coKpi('Costo indirecto / día', money(totalDia), 'account_balance', 'kpi-ico-e')}
      ${coKpi('Costo indirecto / mes', money(totalDia * 30), 'calendar_month', 'kpi-ico-e')}
      ${coKpi('Costo indirecto / año', money(totalDia * 365), 'history', 'kpi-ico-e')}
      ${coKpi('Conceptos activos', num(lista.filter(c => c.activo !== false).length), 'list_alt', 'kpi-ico-p')}
    </div>
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px;line-height:1.6">
      Cada costo se <b>prorratea automáticamente a costo por día</b> según su periodicidad:
      diario ÷1 · semanal ÷7 · quincenal ÷15 · mensual ÷30 · anual ÷365.
      Ejemplo: un arriendo mensual de $900.000 aporta <b>$30.000 por día</b>. Un SOAT anual de $500.000 aporta <b>$1.370 por día</b>.
      Los empaques y bolsas por pan <b>no</b> van aquí: se configuran como adicionales variables en cada tipo de pan.
    </div></div>
    ${lista.length === 0 ? '<div class="empty">Sin costos indirectos. El punto de equilibrio será $0 por ausencia de costos fijos.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Concepto</th><th>Categoría</th><th>Periodicidad</th><th>Valor</th><th>Costo / día</th><th>Estado</th><th></th>
    </tr></thead><tbody>
      ${lista.map(c => {
        const dia = coNum(c.valor) / (CO_DIAS[c.periodicidad] || 30);
        const act = c.activo !== false;
        return `<tr style="${act ? '' : 'opacity:.5'}">
          <td class="bold">${coEsc(c.nombre)}</td>
          <td><span class="badge">${coEsc(c.categoria || 'Otros')}</span></td>
          <td>${c.periodicidad}</td>
          <td class="num">${money(c.valor)}</td>
          <td class="num bold">${money(dia)}</td>
          <td><span class="badge ${act ? 'badge-success' : ''}">${act ? 'Activo' : 'Inactivo'}</span></td>
          <td>
            <button class="btn btn-ghost btn-sm" title="${act ? 'Desactivar' : 'Activar'}" onclick="coToggleInd('${c.id}',${!act})"><span class="ms">visibility</span></button>
            <button class="btn btn-ghost btn-sm" onclick="coIndModal('${c.id}')"><span class="ms">edit</span></button>
            <button class="btn btn-danger btn-sm" onclick="coDelInd('${c.id}')"><span class="ms">delete</span></button>
          </td>
        </tr>`;
      }).join('')}
      <tr style="background:var(--surface-container-low)" class="bold">
        <td colspan="4">TOTAL PRORRATEADO POR DÍA</td>
        <td class="num">${money(totalDia)}</td><td colspan="2"></td>
      </tr>
    </tbody></table></div>`}`;
}

function coIndModal(id) {
  const c = id ? DB.costos.indirectos.find(x => x.id === id) : {
    nombre: '', categoria: 'Servicios públicos', valor: 0,
    periodicidad: 'mensual', fechaInicio: todayKey(), activo: true, observaciones: ''
  };
  if (!c) return;

  modal(id ? 'Editar costo indirecto' : 'Nuevo costo indirecto', `
    <div class="field"><label>Concepto *</label><input id="cx-nombre" value="${coEsc(c.nombre)}" placeholder="Ej: Arriendo del local"/></div>
    <div class="gf">
      <div class="field"><label>Categoría</label>
        <select id="cx-cat">${CO_CAT_INDIRECTO.map(x => `<option ${c.categoria === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Periodicidad</label>
        <select id="cx-per" onchange="coIndPreview()">${Object.keys(CO_DIAS).map(p => `<option value="${p}" ${c.periodicidad === p ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>`).join('')}</select></div>
    </div>
    <div class="gf">
      <div class="field"><label>Valor ($) *</label><input id="cx-val" type="number" step="any" value="${c.valor || ''}" oninput="coIndPreview()"/></div>
      <div class="field"><label>Fecha de inicio</label><input id="cx-fecha" type="date" value="${c.fechaInicio || todayKey()}"/></div>
    </div>
    <div class="field"><label>Observaciones</label><input id="cx-obs" value="${coEsc(c.observaciones || '')}"/></div>
    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b">
      <div id="cx-preview" style="font-family:var(--font-mono);font-size:13px"></div>
    </div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarInd('${id || ''}')">Guardar</button>`);
  coIndPreview();
}

function coIndPreview() {
  const el = $('#cx-preview');
  if (!el) return;
  const v = coNum($('#cx-val').value);
  const per = $('#cx-per').value;
  const dia = v / (CO_DIAS[per] || 30);
  el.innerHTML = v <= 0 ? 'Ingresa un valor para ver el prorrateo.' :
    `Prorrateo automático:<br>
     Por día: <b>${money(dia)}</b><br>
     Por semana: <b>${money(dia * 7)}</b><br>
     Por mes: <b>${money(dia * 30)}</b><br>
     Por año: <b>${money(dia * 365)}</b>`;
}

async function coGuardarInd(id) {
  const data = {
    nombre: $('#cx-nombre').value.trim(),
    categoria: $('#cx-cat').value,
    valor: coNum($('#cx-val').value),
    periodicidad: $('#cx-per').value,
    fechaInicio: $('#cx-fecha').value,
    observaciones: $('#cx-obs').value.trim()
  };
  if (!data.nombre) { toast('El concepto es obligatorio', 'error'); return; }
  if (data.valor <= 0) { toast('El valor debe ser mayor a 0', 'error'); return; }
  try {
    await appwriteService.guardarCostoIndirecto(id ? { id, ...data } : data);
    saveDB(); closeModal(); renderCostos(); toast('Costo guardado', 'success');
  } catch (e) { /* toast ya mostrado */ }
}

async function coToggleInd(id, activo) {
  try { await appwriteService.guardarCostoIndirecto({ id, activo }); saveDB(); renderCostos(); }
  catch (e) { /* toast ya mostrado */ }
}

function coDelInd(id) {
  modal('Eliminar costo indirecto', '<p>Dejará de contarse en el punto de equilibrio de todos los días.</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelIndOk('${id}')">Eliminar</button>`);
}
async function coDelIndOk(id) {
  try { await appwriteService.eliminarCostoIndirecto(id); saveDB(); closeModal(); renderCostos(); toast('Costo eliminado', 'success'); }
  catch (e) { /* toast ya mostrado */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 6 · PUNTO DE EQUILIBRIO
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabEquilibrio(d) {
  const pe = d.pe;
  const color = !pe.calculable ? 'var(--on-surface-variant)' : pe.sinFijos || d.superoPE ? 'var(--tertiary)' : 'var(--error)';
  const compPct = d.costoTotal > 0 ? (d.costoMP / d.costoTotal) * 100 : null;

  return `
    <div class="card mb-md" style="border-left:6px solid ${color}">
      <div class="card-b">
        ${!pe.calculable ? `
          <div style="font-size:20px;font-weight:800">Punto de equilibrio: No calculable</div>
          <div class="mt-sm" style="font-size:13px;line-height:1.6;${pe.mcNoPositivo ? 'color:var(--error);font-weight:700' : ''}">${coEsc(pe.motivo)}</div>` :
        pe.sinFijos ? `
          <div style="font-size:22px;font-weight:800;color:${color}">Punto de equilibrio: $0</div>
          <div class="mt-sm" style="font-size:13px">No hay costos fijos activos. Es un resultado calculado, no un dato faltante: cualquier venta con margen positivo genera utilidad.</div>` : `
          <div style="font-size:22px;font-weight:800;color:${color}">
            ${d.superoPE ? '✓ Se superó el punto de equilibrio' : '✗ No se alcanzó el punto de equilibrio'}
          </div>
          <div class="mt-sm" style="font-size:15px">
            ${d.superoPE
              ? `Excedente sobre el punto de equilibrio: <b style="color:var(--tertiary);font-family:var(--font-mono)">${money(d.brechaPE)}</b>`
              : `Faltaron <b style="color:var(--error);font-family:var(--font-mono)">${money(Math.abs(d.brechaPE))}</b> en ventas cobradas.`}
          </div>`}
      </div>
    </div>

    <div class="grid grid-4 mb-md">
      ${coKpi('Costo de producción', d.costeoIncompleto ? CO_INCOMPLETO : money(d.costoMP), 'trending_down', 'kpi-ico-e', compPct == null ? '' : `${compPct.toFixed(0)}% del costo total`)}
      ${coKpi('Costo indirecto (fijo)', money(d.costoIndirecto), 'account_balance', 'kpi-ico-e', compPct == null ? '' : `${(100 - compPct).toFixed(0)}% del costo total`)}
      ${coKpi('Costo total', coM(d.costoTotal), 'balance', 'kpi-ico-e')}
      ${coKpi('Ventas cobradas del día', money(d.ventasNetas), 'payments', 'kpi-ico-t')}
    </div>
    <div class="grid grid-4 mb-md">
      ${coKpi('Resultado del día', d.utilidad == null ? 'No calculable' : money(d.utilidad), 'savings', d.utilidad != null && d.utilidad >= 0 ? 'kpi-ico-t' : 'kpi-ico-e')}
      ${coKpi('Margen sobre ventas', coPct(d.margen), 'percent', 'kpi-ico-p')}
      ${coKpi('Rentabilidad sobre costo', coPct(d.rentabilidad), 'trending_up', 'kpi-ico-t')}
      ${coKpi('Punto de equilibrio', coPeTexto(d).v, 'swap_horiz', 'kpi-ico-p', pe.calculable && d.peUnidades > 0 ? `${num(d.peUnidades, 0)} unidades entregadas` : '')}
    </div>

    <div class="grid grid-2 mb-md">
      <div class="card">
        <div class="card-h"><div class="card-t">Cómo se calculó</div></div>
        <div class="card-b" style="font-family:var(--font-mono);font-size:13px;line-height:2">
          Ventas cobradas &nbsp;=&nbsp; <b>${money(pe.ingresos)}</b> en <b>${num(pe.unidades)}</b> unidades entregadas<br>
          Precio efectivo / unidad &nbsp;=&nbsp; <b>${money(pe.precioProm)}</b><br>
          Costo variable / unidad (masa + empaques) &nbsp;=&nbsp; <b>${pe.costoVarUnit == null ? 'No calculable' : money(pe.costoVarUnit)}</b><br>
          <span style="color:var(--outline)">──────────────────────────</span><br>
          Margen de contribución / unidad &nbsp;=&nbsp; <b style="color:${pe.mcUnitario > 0 ? 'var(--tertiary)' : 'var(--error)'}">${pe.mcUnitario == null ? 'No calculable' : money(pe.mcUnitario)}</b><br>
          Razón de contribución &nbsp;=&nbsp; <b>${pe.razonMC == null ? '—' : (pe.razonMC * 100).toFixed(1) + '%'}</b><br><br>
          Costos fijos del día &nbsp;=&nbsp; <b>${money(d.costoIndirecto)}</b><br>
          <span style="color:var(--outline)">──────────────────────────</span><br>
          PE en pesos = fijos ÷ razón = <b>${coPeTexto(d).v}</b><br>
          PE en unidades = pesos ÷ precio efectivo = <b>${pe.calculable ? num(d.peUnidades, 0) : '—'}</b>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><div class="card-t">Ventas vs punto de equilibrio</div></div>
        <div class="card-b"><div class="chart-box" style="height:240px"><canvas id="pe-chart"></canvas></div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><div class="card-t">Mezcla de productos usada</div></div>
      <div class="card-b">
        <div class="muted mb-sm" style="font-size:12px;line-height:1.6">
          Se usa la mezcla real vendida en el día. Las unidades incluyen los vendajes (se entregan y cuestan, pero no se cobran).
          Costo variable unitario: el de la producción del día de ese producto; si no se produjo, el costeo vigente de su única categoría de masa.
          Si falta un costo, el punto de equilibrio no se calcula.
        </div>
        ${pe.filas.length === 0 ? '<div class="empty">Sin ventas en el día.</div>' : `
        <div class="tw"><table class="d"><thead><tr>
          <th>Producto</th><th>Cobradas</th><th>Vendajes</th><th>Ingresos</th><th>Precio efectivo</th><th>Costo variable / u</th><th>Fuente</th><th>Contribución</th>
        </tr></thead><tbody>
          ${pe.filas.map(f => `<tr>
            <td class="bold">${coEsc(f.nombre)}</td>
            <td class="num">${num(f.cobradas)}</td><td class="num">${num(f.vendajes)}</td>
            <td class="num">${money(f.ingresos)}</td><td class="num">${money(f.precioEfectivo)}</td>
            <td class="num">${f.costoUnit == null ? CO_INCOMPLETO : money(f.costoUnit)}</td>
            <td class="muted" style="font-size:11.5px">${coEsc(f.costoUnit == null ? f.motivo : f.fuente)}</td>
            <td class="num bold" style="color:${f.contribucion == null ? 'inherit' : f.contribucion > 0 ? 'var(--tertiary)' : 'var(--error)'}">${f.contribucion == null ? '—' : money(f.contribucion)}</td>
          </tr>`).join('')}
        </tbody></table></div>`}
      </div>
    </div>`;
}

function coPintarPE(d) {
  const cv = document.getElementById('pe-chart');
  if (!cv || typeof Chart === 'undefined') return;
  _coCharts.push(new Chart(cv.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Ventas cobradas', 'Punto de equilibrio', 'Costo total'],
      datasets: [{
        data: [d.ventasNetas, d.pePesos, d.costoTotal],
        backgroundColor: ['#00897b', '#f9a825', '#e53935'],
        borderRadius: 8
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.parsed.y == null ? ' No calculable' : ` ${money(c.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: '#000', font: { weight: '700' } }, grid: { display: false } },
        y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => money(v) }, grid: { color: '#e5e7eb' } }
      }
    }
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 7 · ANALÍTICA (10 gráficos)
 * ═══════════════════════════════════════════════════════════════════════════ */

const CO_GRAFICOS = [
  ['cg1', 'Ventas vs Punto de Equilibrio', 'Días sin PE calculable quedan en blanco'],
  ['cg2', 'Resultado diario', 'Verde arriba de cero, rojo abajo · días con costeo incompleto en blanco'],
  ['cg3', 'Rentabilidad diaria (%)', 'Resultado sobre costo total'],
  ['cg4', 'Costo de producción', 'Masa, adicionales/empaques y registros antiguos por lata'],
  ['cg5', 'Costos indirectos por categoría', 'Prorrateo diario vigente'],
  ['cg6', 'Composición de costos', 'Masa, adicionales, latas antiguas e indirectos'],
  ['cg7', 'Producción diaria (panes)', 'Confirmados, estimados y antiguos por lata — sin rendimientos potenciales'],
  ['cg8', 'Arrobas producidas', 'Masa registrada por día'],
  ['cg9', 'Latas', 'Antiguas registradas y equivalentes informativas'],
  ['cg10', 'Costo promedio por pan', 'Costo asignado a panes ÷ panes del día']
];

function coTabAnalitica() {
  return `
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px">
      Ventana de análisis: <b>últimos 30 días</b> hasta el ${_coFecha}. Todos los gráficos salen del mismo cálculo diario que el
      dashboard y la producción, y se recalculan cuando cambian ventas, producción, insumos o costos, en este y en los demás dispositivos.
    </div></div>
    <div class="chart-grid">
      ${CO_GRAFICOS.map(([id, t, sub]) => `
        <div class="chart-card">
          <h4>${t}</h4><div class="chart-sub">${sub}</div>
          <div class="chart-box"><canvas id="${id}"></canvas></div>
        </div>`).join('')}
    </div>`;
}

/** Crea un gráfico o pinta el estado vacío. */
function coChart(id, config, hayDatos) {
  const cv = document.getElementById(id);
  if (!cv) return;
  if (!hayDatos) { cv.parentElement.innerHTML = '<div class="chart-empty">Sin datos todavía</div>'; return; }
  _coCharts.push(new Chart(cv.getContext('2d'), config));
}

/** Opciones base NUEVAS en cada llamada: Chart.js muta el objeto de opciones. */
function coOpts(extra) {
  return Object.assign({
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#000', font: { weight: '700' } } },
      tooltip: { callbacks: { label: c => ` ${c.dataset.label || c.label}: ${money(c.parsed.y ?? c.parsed)}` } }
    },
    scales: {
      x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } },
      y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => money(v) }, grid: { color: '#e5e7eb' } }
    }
  }, extra || {});
}

/** Escalas de barras apiladas. */
function coEscalasApiladas(fmtY) {
  return {
    x: { stacked: true, ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } },
    y: { stacked: true, ticks: { color: '#000', font: { weight: '600' }, callback: fmtY }, grid: { color: '#e5e7eb' } }
  };
}

function coPintarGraficos() {
  if (typeof Chart === 'undefined') { toast('No se pudo cargar la librería de gráficos', 'error'); return; }
  coDestruirGraficos();

  const fechas = coUltimosDias(30);
  const dias = fechas.map(coDia);
  const etiq = fechas.map(f => f.slice(8, 10) + '/' + f.slice(5, 7));
  const hayAlgo = dias.some(d => d.ventasNetas > 0 || d.panes > 0 || d.arrobas > 0);

  /* 1 · Ventas vs PE */
  coChart('cg1', {
    type: 'line',
    data: {
      labels: etiq, datasets: [
        { label: 'Ventas cobradas', data: dias.map(d => d.ventasNetas), borderColor: '#00897b', backgroundColor: 'rgba(0,137,123,.12)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2 },
        { label: 'Punto de equilibrio', data: dias.map(d => d.pePesos), borderColor: '#f9a825', borderDash: [6, 4], tension: .3, borderWidth: 2, pointRadius: 2, fill: false }
      ]
    },
    options: coOpts()
  }, hayAlgo);

  /* 2 · Resultado diario */
  coChart('cg2', {
    type: 'bar',
    data: {
      labels: etiq, datasets: [{
        label: 'Resultado', data: dias.map(d => d.utilidad),
        backgroundColor: dias.map(d => (d.utilidad ?? 0) >= 0 ? '#00897b' : '#e53935'), borderRadius: 4
      }]
    },
    options: coOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)}` } } } })
  }, hayAlgo);

  /* 3 · Rentabilidad diaria (%) */
  coChart('cg3', {
    type: 'line',
    data: { labels: etiq, datasets: [{ label: 'Rentabilidad', data: dias.map(d => d.rentabilidad == null ? null : Number(d.rentabilidad.toFixed(1))), borderColor: '#8a5a1c', backgroundColor: 'rgba(138,90,28,.12)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y}%` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => v + '%' }, grid: { color: '#e5e7eb' } } }
    })
  }, hayAlgo);

  /* 4 · Costo de producción (apilado) */
  coChart('cg4', {
    type: 'bar',
    data: {
      labels: etiq, datasets: [
        { label: 'Masa', data: dias.map(d => d.costoMasa), backgroundColor: '#e53935', borderRadius: 4 },
        { label: 'Adicionales y empaques', data: dias.map(d => d.costoAdicionales), backgroundColor: '#fb8c00', borderRadius: 4 },
        { label: 'Por lata (antiguos)', data: dias.map(d => d.costoLata), backgroundColor: '#6d4c41', borderRadius: 4 }
      ]
    },
    options: coOpts({ scales: coEscalasApiladas(v => money(v)) })
  }, dias.some(d => d.costoMP > 0));

  /* 5 · Costos indirectos por categoría */
  const porCat = coIndirectoPorCategoria();
  const cats = Object.keys(porCat);
  coChart('cg5', {
    type: 'bar',
    data: { labels: cats, datasets: [{ label: 'Costo / día', data: cats.map(c => porCat[c]), backgroundColor: cats.map((_, i) => CO_COLORS[i % CO_COLORS.length]), borderRadius: 6 }] },
    options: coOpts({
      indexAxis: 'y',
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.x)} / día` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, callback: v => money(v) }, grid: { color: '#e5e7eb' } }, y: { ticks: { color: '#000', font: { weight: '700' } }, grid: { display: false } } }
    })
  }, cats.length > 0);

  /* 6 · Composición de costos */
  const totMasa = dias.reduce((a, d) => a + d.costoMasa, 0);
  const totAd = dias.reduce((a, d) => a + d.costoAdicionales, 0);
  const totLata = dias.reduce((a, d) => a + d.costoLata, 0);
  const totCI = dias.reduce((a, d) => a + d.costoIndirecto, 0);
  const totComp = totMasa + totAd + totLata + totCI;
  coChart('cg6', {
    type: 'doughnut',
    data: { labels: ['Masa', 'Adicionales y empaques', 'Por lata (antiguos)', 'Costos indirectos'], datasets: [{ data: [totMasa, totAd, totLata, totCI], backgroundColor: ['#e53935', '#fb8c00', '#6d4c41', '#8a5a1c'], borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#000', font: { weight: '700' }, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${money(c.parsed)} (${totComp > 0 ? ((c.parsed / totComp) * 100).toFixed(1) : 0}%)` } }
      }
    }
  }, totComp > 0);

  /* 7 · Producción diaria (panes) */
  coChart('cg7', {
    type: 'bar',
    data: {
      labels: etiq, datasets: [
        { label: 'Confirmados', data: dias.map(d => d.panesConfirmados), backgroundColor: '#00897b', borderRadius: 4 },
        { label: 'Estimados', data: dias.map(d => d.panesEstimados), backgroundColor: '#9fa8da', borderRadius: 4 },
        { label: 'Por lata (antiguos)', data: dias.map(d => d.panesLata), backgroundColor: '#6d4c41', borderRadius: 4 }
      ]
    },
    options: coOpts({
      plugins: { legend: { labels: { color: '#000', font: { weight: '700' } } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${num(c.parsed.y)} panes` } } },
      scales: coEscalasApiladas(v => num(v))
    })
  }, dias.some(d => d.panes > 0));

  /* 8 · Arrobas producidas */
  coChart('cg8', {
    type: 'bar',
    data: { labels: etiq, datasets: [{ label: 'Arrobas', data: dias.map(d => Number(d.arrobas.toFixed(3))), backgroundColor: '#8e24aa', borderRadius: 4 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${coN(c.parsed.y, 3)} arrobas` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => coN(v) + ' @' }, grid: { color: '#e5e7eb' } } }
    })
  }, dias.some(d => d.arrobas > 0));

  /* 9 · Latas */
  coChart('cg9', {
    type: 'bar',
    data: {
      labels: etiq, datasets: [
        { label: 'Registradas (antiguos)', data: dias.map(d => d.latas), backgroundColor: '#fb8c00', borderRadius: 4 },
        { label: 'Equivalentes (informativo)', data: dias.map(d => Number(d.latasEq.toFixed(2))), backgroundColor: '#ffcc80', borderRadius: 4 }
      ]
    },
    options: coOpts({
      plugins: { legend: { labels: { color: '#000', font: { weight: '700' } } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${coN(c.parsed.y, 1)} latas` } } },
      scales: coEscalasApiladas(v => coN(v))
    })
  }, dias.some(d => d.latas > 0 || d.latasEq > 0));

  /* 10 · Costo promedio por pan */
  coChart('cg10', {
    type: 'line',
    data: { labels: etiq, datasets: [{ label: 'Costo / pan', data: dias.map(d => d.costoPromedioPan == null ? null : Number(d.costoPromedioPan.toFixed(0))), borderColor: '#546e7a', backgroundColor: 'rgba(84,110,122,.14)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2, spanGaps: true }] },
    options: coOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)} por pan` } } } })
  }, dias.some(d => d.costoPromedioPan > 0));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * EXPORTAR COSTEO COMPLETO A EXCEL
 * ---------------------------------------------------------------------------
 * Libro con fórmulas vivas, armado con los datos reales del panel:
 *   Resumen · Parámetros · Panes · Masas · Adicionales · Insumos · Costos fijos
 * Costo total por pan = masa + merma + adicionales/empaque + vendajes (variable)
 *                     + costo fijo asignado (indirectos + nómina, en proporción
 *                       a lo que vale el pan: precio × %costo fijo sobre ventas).
 * Las celdas amarillas con letra azul son supuestos editables.
 * ═══════════════════════════════════════════════════════════════════════════ */

let _coXlsxStyle = null;
/** Carga xlsx-js-style (SheetJS con colores). Si falla usa el SheetJS normal. */
function coCargarXlsxEstilos() {
  if (_coXlsxStyle) return Promise.resolve(_coXlsxStyle);
  return new Promise((ok) => {
    const previo = window.XLSX;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
    s.onload = () => { _coXlsxStyle = window.XLSX; if (previo) window.XLSX = previo; ok(_coXlsxStyle); };
    s.onerror = () => { if (previo) window.XLSX = previo; ok(null); };
    document.head.appendChild(s);
  }).then(x => x || (typeof _cargarSheetJS === 'function' ? _cargarSheetJS() : null));
}

/** Ventas de los pedidos de los últimos 90 días, llevadas a un mes de 30 días. */
function coXVentasMes() {
  const k = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoy = new Date(todayKey() + 'T12:00:00');
  const ini = new Date(hoy); ini.setDate(ini.getDate() - 89);
  const hoyK = k(hoy), iniK = k(ini);
  const peds = (DB.pedidos || []).filter(p => { const f = String(p.fecha || '').slice(0, 10); return f >= iniK && f <= hoyK; });
  let primera = hoyK, total = 0;
  const porProd = {};
  peds.forEach(p => {
    const f = String(p.fecha).slice(0, 10);
    if (f < primera) primera = f;
    total += coNum(p.total);
    (p.items || []).forEach(it => {
      const o = porProd[it.productoId] || (porProd[it.productoId] = { cant: 0, vend: 0 });
      o.cant += coNum(it.cantidad);
      o.vend += coNum(it.vendajes);
    });
  });
  const dias = peds.length ? Math.min(90, Math.round((hoy - new Date(primera + 'T12:00:00')) / 864e5) + 1) : 0;
  const f = dias > 0 ? 30 / dias : 0;
  Object.values(porProd).forEach(o => { o.cantMes = o.cant * f; o.pctVend = o.cant > 0 ? o.vend / o.cant : 0; });
  return { ventasMes: total * f, dias, pedidos: peds.length, porProd };
}

async function coExportarCosteoExcel() {
  const cats = coCategorias().filter(c => c.activo !== false);
  if (!cats.length) { toast('No hay categorías de masa activas para costear', 'error'); return; }
  toast('Armando el Excel de costeo…', 'info');
  const X = await coCargarXlsxEstilos().catch(() => null);
  if (!X) { toast('No se pudo cargar el generador de Excel (revisa internet)', 'error'); return; }

  /* ---------- estilos ---------- */
  const CAFE = '8A5A1C', CAFE_OSC = '5D3A10', CREMA = 'F6EBDD';
  const BRD = { top: { style: 'thin', color: { rgb: 'D9CBB8' } }, bottom: { style: 'thin', color: { rgb: 'D9CBB8' } }, left: { style: 'thin', color: { rgb: 'D9CBB8' } }, right: { style: 'thin', color: { rgb: 'D9CBB8' } } };
  const ST = {
    tit: { font: { bold: true, sz: 16, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: CAFE } }, alignment: { vertical: 'center' } },
    sub: { font: { italic: true, sz: 10, color: { rgb: '6B5B4B' } } },
    nota: { font: { sz: 10, color: { rgb: '555555' } }, alignment: { wrapText: true, vertical: 'top' } },
    sec: { font: { bold: true, sz: 12, color: { rgb: CAFE_OSC } }, fill: { fgColor: { rgb: CREMA } } },
    head: { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: CAFE_OSC } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true }, border: BRD },
    td: { border: BRD, alignment: { vertical: 'center' } },
    lbl: { border: BRD, font: { bold: true }, alignment: { vertical: 'center', wrapText: true } },
    inp: { border: BRD, font: { color: { rgb: '0000FF' } }, fill: { fgColor: { rgb: 'FFF2CC' } } },
    tot: { border: BRD, font: { bold: true }, fill: { fgColor: { rgb: 'EDE3D3' } } },
    big: { border: BRD, font: { bold: true, sz: 13 } },
    bad: { fill: { fgColor: { rgb: 'F8D7DA' } }, font: { bold: true, color: { rgb: '9C0006' } } },
    warn: { fill: { fgColor: { rgb: 'FFEB9C' } }, font: { bold: true, color: { rgb: '9C5700' } } },
    ok: { fill: { fgColor: { rgb: 'C6EFCE' } }, font: { bold: true, color: { rgb: '006100' } } }
  };
  const M0 = '"$"#,##0', M2 = '"$"#,##0.00', P1 = '0.0%', N2 = 'AUTO', N4 = '0.0000';
  const fmtN = (z, v) => z === 'AUTO' ? (typeof v === 'number' && !Number.isInteger(v) ? '#,##0.00' : '#,##0') : z;
  const mix = (z, ...ss) => {
    const o = {};
    ss.filter(Boolean).forEach(s => Object.keys(s).forEach(k => { o[k] = typeof s[k] === 'object' ? { ...(o[k] || {}), ...s[k] } : s[k]; }));
    if (z) o.numFmt = z;
    return o;
  };
  const C = (v, z, ...ss) => { z = fmtN(z, v); return { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', z, s: mix(z, ST.td, ...ss) }; };
  const F = (f, v, z, ...ss) => { z = fmtN(z, v); return { f, v: typeof v === 'string' ? v : (Number.isFinite(v) ? v : 0), t: typeof v === 'string' ? 's' : 'n', z, s: mix(z, ST.td, ...ss) }; };
  const T = (v, st) => ({ v, t: 's', s: st });
  const hoja = () => { const S = { rows: [], merges: [], cols: [] }; S.add = (cells) => { S.rows.push(cells); return S.rows.length; }; return S; };
  const titulo = (S, txt, ancho, sub) => {
    S.add([T(txt, ST.tit), ...Array(ancho - 1).fill(T('', ST.tit))]);
    S.merges.push({ s: { r: S.rows.length - 1, c: 0 }, e: { r: S.rows.length - 1, c: ancho - 1 } });
    if (sub) S.add([T(sub, ST.sub)]);
    S.add([]);
  };
  const aWs = (S) => {
    const ws = {};
    let maxC = 0;
    S.rows.forEach((cells, r) => cells.forEach((c, ci) => {
      if (c == null) return;
      const cell = typeof c === 'object' ? { ...c } : { v: c, t: typeof c === 'number' ? 'n' : 's' };
      if (cell.f && cell.f.startsWith('=')) cell.f = cell.f.slice(1);
      ws[X.utils.encode_cell({ r, c: ci })] = cell;
      maxC = Math.max(maxC, ci);
    }));
    ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, S.rows.length - 1), c: maxC } });
    ws['!merges'] = S.merges;
    ws['!cols'] = S.cols.map(w => ({ wch: w }));
    return ws;
  };
  const col = (i) => X.utils.encode_col(i);
  const SH = { res: "'Resumen'", par: "'Parámetros'", pan: "'Panes'", mas: "'Masas'", ad: "'Adicionales'", ins: "'Insumos'", cf: "'Costos fijos'" };

  /* ---------- datos base ---------- */
  const ven = coXVentasMes();
  const fc = DB.facturaConfig || {};
  const negocio = fc.nombreNegocio || 'Panadería';
  const fechaTxt = todayKey();

  /* ============ INSUMOS ============ */
  const SI = hoja();
  SI.cols = [32, 16, 12, 13, 12, 15, 9, 15, 16, 13, 20];
  titulo(SI, 'INSUMOS · PRECIOS VIGENTES', 11, `Última compra registrada de cada insumo. Precio por unidad base = precio de compra ÷ (cantidad × contenido). Exportado el ${fechaTxt}.`);
  SI.add(['Insumo', 'Categoría', 'Cantidad comprada', 'Unidad de compra', 'Contenido por unidad', 'Precio de compra', 'Unidad base', 'Precio por unidad base', 'Precio por kg / L / und', 'Última compra', 'Proveedor'].map(h => T(h, ST.head)));
  const insRow = {}, insPrecio = {};
  (DB.costos.insumos || []).slice()
    .sort((a, b) => (a.esMezcla ? 1 : 0) - (b.esMezcla ? 1 : 0) || String(a.categoria || '').localeCompare(String(b.categoria || '')) || a.nombre.localeCompare(b.nombre))
    .forEach(i => {
      const st = coEstadoInsumo(i);
      const pb = st.ok ? coNum(i.precioBase) : 0;
      const base = coBaseLabel(i.unidadCompra);
      const r = SI.rows.length + 1;
      SI.add([
        C(i.nombre, null, { font: { bold: true } }),
        C(i.esMezcla ? 'Mezcla propia' : (i.categoria || 'Otros')),
        i.esMezcla ? C(coNum(i.rendimiento), N2) : C(coNum(i.cantidadComprada), N2),
        C(i.esMezcla ? 'g (rinde)' : (i.unidadCompra || '')),
        C(coNum(i.contenidoPorUnidad) > 0 ? coNum(i.contenidoPorUnidad) : '', N2),
        C(i.esMezcla ? coNum(i.precioCompra) : coNum(i.precioCompra), M0),
        C(base),
        C(pb, N4, ST.inp, st.ok ? null : ST.bad),
        F(`H${r}*IF(OR(G${r}="g",G${r}="ml"),1000,1)`, pb * (base === 'g' || base === 'ml' ? 1000 : 1), M0),
        C(i.fechaCompra || ''),
        C(st.ok ? (i.proveedor || '') : `⚠ ${st.motivo}`, null, st.ok ? null : ST.bad)
      ]);
      insRow[i.id] = r; insPrecio[i.id] = pb;
    });
  SI.add([]);
  SI.add([T('El precio por unidad base (amarillo) es el que usan las masas y los adicionales. Si cambias uno aquí, todo el libro se recalcula. Las mezclas propias muestran su precio por gramo calculado con sus ingredientes.', ST.nota)]);
  SI.merges.push({ s: { r: SI.rows.length - 1, c: 0 }, e: { r: SI.rows.length - 1, c: 10 } });
  const precioRef = (id) => insRow[id] ? `${SH.ins}!$H$${insRow[id]}` : '0';

  /* ============ PARÁMETROS ============ */
  const indirectos = (DB.costos.indirectos || []);
  const empleados = (DB.nomina && DB.nomina.empleados) || [];
  const nominaEnIndirectos = indirectos.some(c => c.activo !== false && /salari|n[oó]mina|sueldo|mano de obra|empleado/i.test(`${c.nombre} ${c.categoria}`));
  const SP = hoja();
  SP.cols = [46, 18, 70];
  titulo(SP, 'PARÁMETROS DEL COSTEO', 3, 'Celdas amarillas (letra azul) = supuestos que puedes cambiar. Todo el libro se recalcula solo.');
  SP.add(['Concepto', 'Valor', 'Qué significa'].map(h => T(h, ST.head)));
  const P = {};
  const par = (key, lbl, cell, nota) => { const r = SP.rows.length + 1; SP.add([C(lbl, null, ST.lbl), cell, C(nota, null, ST.nota)]); P[key] = `${SH.par}!$B$${r}`; return r; };
  // Las filas de costos fijos se enlazan después de construir esa hoja (se completan abajo).
  const rVentas = par('ventas', 'Ventas promedio por mes', C(Math.round(ven.ventasMes), M0, ST.inp),
    ven.dias ? `Calculado con ${ven.pedidos} pedidos de los últimos ${ven.dias} días, llevado a 30 días. Cámbialo si esperas vender otra cosa.` : 'No hay pedidos en los últimos 90 días: escribe cuánto vendes al mes.');
  const rInd = SP.rows.length + 1; SP.add([]);  // se llena después
  const rNom = SP.rows.length + 1; SP.add([]);
  const rCarga = par('carga', 'Carga prestacional sobre la nómina', C(0, P1, ST.inp),
    'Si pagas prestaciones (salud, pensión, ARL, primas, cesantías, vacaciones), en Colombia suman cerca del 52% del salario. Si pagas solo el salario, déjalo en 0%.');
  const rIncl = par('incl', 'Incluir nómina en el costeo (1 = sí, 0 = no)', C(nominaEnIndirectos ? 0 : 1, '0', ST.inp),
    nominaEnIndirectos ? 'Está en 0 porque en "Costos indirectos" ya hay un concepto de salarios/nómina; así no se cuenta dos veces.' : 'La nómina registrada en el panel es mano de obra: entra como costo fijo.');
  const rCF = SP.rows.length + 1; SP.add([]);
  const rPct = SP.rows.length + 1; SP.add([]);
  const rMerma = par('merma', 'Merma de masa', C(0.03, P1, ST.inp),
    'Masa que se pierde (pegada en la mesa, recortes, panes dañados o quemados). Lo normal es 2% a 5%. Pon 0% si no quieres contarla.');
  const rMeta = par('meta', 'Margen de ganancia objetivo', C(0.3, P1, ST.inp),
    'Lo que quieres ganar sobre el precio, después de todos los costos. Se usa para el precio sugerido.');
  const rDias = par('dias', 'Días de trabajo al mes', C(30, '0', ST.inp), 'Para pasar el punto de equilibrio a ventas por día.');

  /* ============ COSTOS FIJOS ============ */
  const SC = hoja();
  SC.cols = [34, 20, 13, 15, 11, 16, 15, 11];
  titulo(SC, 'COSTOS FIJOS · INDIRECTOS Y NÓMINA', 8, 'Todo se lleva a mes de 30 días: valor ÷ días del período × 30.');
  SC.add([T('COSTOS INDIRECTOS (arriendo, servicios, gas, transporte…)', ST.sec)]);
  SC.add(['Concepto', 'Categoría', 'Periodicidad', 'Valor', 'Días del período', 'Costo por mes', 'Costo por día', 'Activo'].map(h => T(h, ST.head)));
  const indIni = SC.rows.length + 1;
  let indMes = 0;
  indirectos.slice().sort((a, b) => String(a.categoria).localeCompare(String(b.categoria))).forEach(c => {
    const r = SC.rows.length + 1;
    const d = CO_DIAS[c.periodicidad] || 30;
    const act = c.activo !== false;
    if (act) indMes += coNum(c.valor) / d * 30;
    SC.add([C(c.nombre, null, { font: { bold: true } }), C(c.categoria || 'Otros'), C(c.periodicidad || 'mensual'),
      C(coNum(c.valor), M0, ST.inp), C(d, '0'),
      F(`IF(H${r}="Sí",D${r}/E${r}*30,0)`, act ? coNum(c.valor) / d * 30 : 0, M0),
      F(`IF(H${r}="Sí",D${r}/E${r},0)`, act ? coNum(c.valor) / d : 0, M0),
      C(act ? 'Sí' : 'No', null, ST.inp)]);
  });
  if (!indirectos.length) SC.add([C('(no hay costos indirectos registrados en el panel)', null, ST.nota)]);
  const indFin = Math.max(indIni, SC.rows.length);
  const rIndTot = SC.rows.length + 1;
  SC.add([C('TOTAL INDIRECTOS', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot),
    F(`SUM(F${indIni}:F${indFin})`, indMes, M0, ST.tot), F(`SUM(G${indIni}:G${indFin})`, indMes / 30, M0, ST.tot), C('', null, ST.tot)]);
  SC.add([]);
  SC.add([T('NÓMINA (mano de obra)', ST.sec)]);
  SC.add(['Empleado', 'Periodo de pago', 'Salario base', 'Días del período', 'Costo por mes', '', '', ''].map((h, i) => i < 5 ? T(h, ST.head) : null));
  const nomIni = SC.rows.length + 1;
  let nomMes = 0;
  empleados.forEach(e => {
    const r = SC.rows.length + 1;
    const d = CO_DIAS[e.periodo] || 30;
    nomMes += coNum(e.salarioBase) / d * 30;
    SC.add([C(e.nombre, null, { font: { bold: true } }), C(e.periodo || 'mensual'), C(coNum(e.salarioBase), M0, ST.inp), C(d, '0'), F(`C${r}/D${r}*30`, coNum(e.salarioBase) / d * 30, M0)]);
  });
  if (!empleados.length) SC.add([C('(no hay empleados registrados en Nómina)', null, ST.nota)]);
  const nomFin = Math.max(nomIni, SC.rows.length);
  const rNomTot = SC.rows.length + 1;
  SC.add([C('TOTAL NÓMINA (salario base)', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), F(`SUM(E${nomIni}:E${nomFin})`, nomMes, M0, ST.tot)]);
  SC.add([]);
  SC.add([T('Los empaques y bolsas por pan NO van aquí: están como adicionales variables de cada pan (hoja Adicionales).', ST.nota)]);
  SC.merges.push({ s: { r: SC.rows.length - 1, c: 0 }, e: { r: SC.rows.length - 1, c: 7 } });

  // Completa las filas de Parámetros que dependen de los costos fijos.
  const carga = 0, incl = nominaEnIndirectos ? 0 : 1;
  const nomCosteo = nomMes * (1 + carga);
  const cfMes = indMes + nomCosteo * incl;
  const pctCF = ven.ventasMes > 0 ? cfMes / ven.ventasMes : 0;
  SP.rows[rInd - 1] = [C('Costos indirectos por mes', null, ST.lbl), F(`${SH.cf}!F${rIndTot}`, indMes, M0), C('Viene de la hoja "Costos fijos" (solo los activos).', null, ST.nota)];
  SP.rows[rNom - 1] = [C('Nómina por mes (con carga prestacional)', null, ST.lbl), F(`${SH.cf}!E${rNomTot}*(1+B${rCarga})`, nomCosteo, M0), C('Salarios de la hoja "Costos fijos" más la carga prestacional de abajo.', null, ST.nota)];
  SP.rows[rCF - 1] = [C('TOTAL COSTOS FIJOS POR MES', null, ST.lbl, ST.tot), F(`B${rInd}+B${rNom}*B${rIncl}`, cfMes, M0, ST.tot), C('Indirectos + nómina. Es lo que hay que cubrir cada mes antes de ganar.', null, ST.nota)];
  SP.rows[rPct - 1] = [C('% de costo fijo sobre ventas', null, ST.lbl, ST.tot), F(`IF(B${rVentas}>0,B${rCF}/B${rVentas},0)`, pctCF, P1, ST.tot), C('De cada $100 que vendes, cuánto se va en costos fijos. Cada pan carga ese % de su precio.', null, ST.nota)];
  P.ind = `${SH.par}!$B$${rInd}`; P.nom = `${SH.par}!$B$${rNom}`; P.cf = `${SH.par}!$B$${rCF}`; P.pct = `${SH.par}!$B$${rPct}`;
  const merma = 0.03, meta = 0.3, diasMes = 30;

  /* ============ MASAS ============ */
  const SM = hoja();
  SM.cols = [34, 14, 9, 15, 15, 13, 15];
  titulo(SM, 'MASAS · RECETAS Y COSTO POR BOLITA / GRAMO', 7, 'Cantidad de cada ingrediente según la receta base. % panadero = ingrediente ÷ harina (harina = 100%).');
  const catInfo = {};
  cats.forEach(cat => {
    const snap = coSnapshotCategoria(cat);
    const rc = coCosteoReceta(snap);
    const p = coParams(cat.parametros);
    const ab = coNum(cat.arrobasBase) || 1;
    SM.add([T(`MASA: ${cat.nombre}`, ST.sec), T('', ST.sec), T('', ST.sec), T('', ST.sec), T('', ST.sec), T('', ST.sec), T('', ST.sec)]);
    SM.add(['Ingrediente', 'Cantidad (receta)', 'Unidad', 'Precio unitario', 'Costo', '% panadero', 'Por 1 arroba'].map(h => T(h, ST.head)));
    const ini = SM.rows.length + 1;
    const harinaQty = (cat.ingredientes || []).filter(g => /harina/i.test(coInsumo(g.insumoId)?.nombre || '')).reduce((a, g) => a + coNum(g.cantidad), 0);
    const filasHarina = [];
    (cat.ingredientes || []).forEach(g => {
      const r = SM.rows.length + 1;
      const ins = coInsumo(g.insumoId);
      if (/harina/i.test(ins?.nombre || '')) filasHarina.push(r);
      const pr = insPrecio[g.insumoId] || 0;
      SM.add([C(ins ? ins.nombre : '(insumo eliminado)', null, { font: { bold: true } }), C(coNum(g.cantidad), N2, ST.inp), C(ins ? coBaseLabel(ins.unidadCompra) : ''),
        F(precioRef(g.insumoId), pr, N4), F(`B${r}*D${r}`, coNum(g.cantidad) * pr, M0), null, F(`B${r}/${ab}`, coNum(g.cantidad) / ab, N2)]);
    });
    const fin = Math.max(ini, SM.rows.length);
    const harinaF = filasHarina.length ? filasHarina.map(r => `B${r}`).join('+') : null;
    for (let r = ini; r <= fin; r++) {
      const row = SM.rows[r - 1];
      if (row && row.length) row[5] = harinaF ? F(`IF((${harinaF})>0,B${r}/(${harinaF}),0)`, harinaQty > 0 ? coNum(row[1].v) / harinaQty : 0, P1) : C('—');
    }
    const costoRec = (cat.ingredientes || []).reduce((a, g) => a + coNum(g.cantidad) * (insPrecio[g.insumoId] || 0), 0);
    const rTot = SM.rows.length + 1;
    SM.add([C('COSTO DE LA RECETA', null, ST.tot), F(`SUM(B${ini}:B${fin})`, (cat.ingredientes || []).reduce((a, g) => a + coNum(g.cantidad), 0), N2, ST.tot), C('', null, ST.tot), C('', null, ST.tot),
      F(`SUM(E${ini}:E${fin})`, costoRec, M0, ST.tot), harinaF ? F(`SUM(F${ini}:F${fin})`, harinaQty > 0 ? (cat.ingredientes || []).reduce((a, g) => a + coNum(g.cantidad), 0) / harinaQty : 0, P1, ST.tot) : C('', null, ST.tot), C('', null, ST.tot)]);
    const kv = (lbl, cell, nota) => { const r = SM.rows.length + 1; SM.add([C(lbl, null, ST.lbl), cell, nota ? C(nota, null, ST.nota) : null]); if (nota) SM.merges.push({ s: { r: r - 1, c: 2 }, e: { r: r - 1, c: 6 } }); return r; };
    const rAb = kv('Arrobas de la receta', C(ab, N2, ST.inp));
    const rCA = kv('Costo de masa por arroba', F(`E${rTot}/B${rAb}`, costoRec / ab, M0, ST.big));
    const rPep = kv('Pepas por arroba', C(p.pepasPorArroba, N2, ST.inp));
    const rBpp = kv('Bolitas por pepa (pique)', C(p.bolitasPorPepa, N2, ST.inp));
    const rBpa = kv('Bolitas por arroba', F(`B${rPep}*B${rBpp}`, p.pepasPorArroba * p.bolitasPorPepa, N2));
    const cpb = costoRec / ab / (p.pepasPorArroba * p.bolitasPorPepa);
    const rCpb = kv('COSTO POR BOLITA', F(`B${rCA}/B${rBpa}`, cpb, M2, ST.big, ST.ok));
    const pm = coDec(cat.pesoMasaKg) > 0 ? coDec(cat.pesoMasaKg) : '';
    const rPm = kv('Peso de la masa cruda de 1 arroba (kg)', C(pm, N2, ST.inp), pm ? null : 'Pésala y escríbela aquí para ver el costo por gramo y el peso de la bolita.');
    kv('Peso de 1 bolita (g)', F(`IF(B${rPm}>0,B${rPm}*1000/B${rBpa},"")`, pm ? pm * 1000 / (p.pepasPorArroba * p.bolitasPorPepa) : '', N2));
    kv('Costo por gramo de masa', F(`IF(B${rPm}>0,B${rCA}/(B${rPm}*1000),"")`, pm ? costoRec / ab / (pm * 1000) : '', M2));
    kv('Costo por kilo de masa', F(`IF(B${rPm}>0,B${rCA}/B${rPm},"")`, pm ? costoRec / ab / pm : '', M0));
    if (rc.motivos.length) kv('⚠ Costeo incompleto en el panel', C(rc.motivos.join(' · '), null, ST.bad));
    SM.add([]);
    catInfo[cat.id] = { snap, rc, cpbRef: `${SH.mas}!$B$${rCpb}`, cpb, bpa: p.pepasPorArroba * p.bolitasPorPepa, pesoBol: pm ? pm * 1000 / (p.pepasPorArroba * p.bolitasPorPepa) : null };
  });

  /* ============ ADICIONALES ============ */
  const SA = hoja();
  SA.cols = [22, 26, 30, 11, 9, 20, 7, 14, 13, 14, 30];
  titulo(SA, 'ADICIONALES Y EMPAQUES POR PAN', 11, 'Rellenos, coberturas, bolsas, etc. Costo por pan = unidades por pan × precio unitario.');
  SA.add(['Masa', 'Pan', 'Insumo', 'Cantidad', 'Unidad', 'Base', 'N', 'Precio unitario', 'Unidades por pan', 'Costo por pan', 'Nota'].map(h => T(h, ST.head)));
  const adIni = SA.rows.length + 1;
  const loteTxt = {};
  cats.forEach(cat => {
    const ci = catInfo[cat.id];
    ci.snap.lineas.forEach((l, li) => {
      const bpp = coNum(l.bolitasPorPan);
      const lista = [...(l.adicionales || []).map(a => ({ a, deMasa: false })), ...(ci.snap.adicionales || []).map(a => ({ a, deMasa: true }))];
      lista.forEach(({ a, deMasa }) => {
        const r = SA.rows.length + 1;
        const pr = insPrecio[a.insumoId] || 0;
        let fU, vU, nota = '';
        if (a.base === 'pan') { fU = `D${r}`; vU = a.cantidad; }
        else if (a.base === 'grupo') { fU = `D${r}/G${r}`; vU = a.cantidad / a.grupo; nota = `Se reparte entre ${a.grupo} panes`; }
        else if (a.base === 'arroba') { fU = `D${r}*${bpp}/${ci.bpa}`; vU = a.cantidad * bpp / ci.bpa; nota = `Por arroba: ${coN(bpp, 4)} bolitas de ${ci.bpa}`; }
        else { fU = '0'; vU = 0; nota = `Fijo por producción: ${money(a.cantidad * pr)} cada vez (no se suma por pan)`; loteTxt[l.lineaId] = (loteTxt[l.lineaId] || 0) + a.cantidad * pr; }
        const qty = a.gramosPorUnidad ? a.cantidad : a.cantidad;
        SA.add([C(cat.nombre), C(l.nombre, null, { font: { bold: true } }), C(a.nombre + (deMasa ? ' (de la masa)' : '')),
          C(qty, N4, ST.inp), C(a.unidad || 'und'), C(CO_BASES_AD[a.base] || a.base), C(a.base === 'grupo' ? a.grupo : '', '0', a.base === 'grupo' ? ST.inp : null),
          F(precioRef(a.insumoId), pr, N4), F(fU, vU, N4), F(`I${r}*H${r}`, vU * pr, M2), C(nota, null, ST.nota)]);
      });
    });
  });
  if (SA.rows.length < adIni) SA.add([C('(ningún pan tiene adicionales configurados)', null, ST.nota)]);
  const adFin = Math.max(adIni, SA.rows.length);

  /* ============ PANES ============ */
  const SPn = hoja();
  const hdr = ['Masa', 'Pan', 'Precio de venta', 'Bolitas por pan', 'Gramos de masa', 'Costo masa', 'Merma', 'Adicionales y empaque', 'Vendajes (regalados)', 'COSTO VARIABLE',
    'Costo fijo asignado', 'COSTO TOTAL', 'UTILIDAD POR PAN', 'Margen neto %', 'Margen de contribución', 'MC %', 'Precio sugerido', 'Unidades vendidas / mes', '% vendaje', 'Utilidad al mes', 'Estado'];
  SPn.cols = [18, 26, 12, 10, 10, 12, 10, 13, 12, 13, 12, 13, 13, 10, 13, 9, 13, 12, 9, 14, 13];
  titulo(SPn, `COSTEO POR PAN · ${negocio}`, hdr.length, 'Costo variable = masa + merma + adicionales + vendajes. Costo total = variable + costo fijo asignado (precio × % de costo fijo sobre ventas).');
  SPn.add(hdr.map(h => T(h, ST.head)));
  const pIni = SPn.rows.length + 1;
  const resumenPanes = [];
  const costeados = new Set();
  cats.forEach(cat => {
    const ci = catInfo[cat.id];
    ci.snap.lineas.forEach((l, li) => {
      const r = SPn.rows.length + 1;
      costeados.add(l.productoId);
      const u = coCosteoUnitario(ci.snap, l, ci.rc);
      const precio = coNum(l.precioVenta);
      const bpp = coNum(l.bolitasPorPan);
      const linea = (cat.productos || [])[li] || {};
      const gramos = coNum(linea.gramosMasa) > 0 ? coNum(linea.gramosMasa) / Math.max(1, coNum(linea.piezas, 1)) : (ci.pesoBol ? bpp * ci.pesoBol : '');
      const masa = bpp * ci.cpb;
      const mer = masa * merma;
      // Adicionales: recalculados con los precios de la hoja Insumos (misma regla que el panel).
      let adic = 0;
      [...(l.adicionales || []), ...(ci.snap.adicionales || [])].forEach(a => {
        const pr = insPrecio[a.insumoId] || 0;
        if (a.base === 'pan') adic += a.cantidad * pr;
        else if (a.base === 'grupo') adic += a.cantidad * pr / a.grupo;
        else if (a.base === 'arroba') adic += a.cantidad * pr * bpp / ci.bpa;
      });
      const vp = ven.porProd[l.productoId] || { cantMes: 0, pctVend: 0 };
      const vend = (masa + mer + adic) * vp.pctVend;
      const cv = masa + mer + adic + vend;
      const fijo = precio * pctCF;
      const total = cv + fijo;
      const util = precio - total;
      const mpct = precio > 0 ? util / precio : 0;
      const estado = util < 0 ? 'PÉRDIDA' : (mpct < meta ? 'Margen bajo' : 'OK');
      const stE = estado === 'PÉRDIDA' ? ST.bad : (estado === 'OK' ? ST.ok : ST.warn);
      const nombre = l.nombre + (gramos && coNum(linea.piezas) > 1 ? ` (${coNum(linea.gramosMasa)} g ÷ ${linea.piezas})` : '');
      SPn.add([
        C(cat.nombre), C(nombre, null, { font: { bold: true } }), C(precio, M0, ST.inp), C(bpp, N4, ST.inp), C(gramos === '' ? '' : Math.round(gramos * 10) / 10, N2),
        F(`D${r}*${ci.cpbRef}`, masa, M0),
        F(`F${r}*${P.merma}`, mer, M0),
        F(`SUMIFS(${SH.ad}!$J$${adIni}:$J$${adFin},${SH.ad}!$A$${adIni}:$A$${adFin},A${r},${SH.ad}!$B$${adIni}:$B$${adFin},"${String(l.nombre).replace(/"/g, '""')}")`, adic, M0),
        F(`(F${r}+G${r}+H${r})*S${r}`, vend, M0),
        F(`F${r}+G${r}+H${r}+I${r}`, cv, M0, { font: { bold: true } }),
        F(`C${r}*${P.pct}`, fijo, M0),
        F(`J${r}+K${r}`, total, M0, { font: { bold: true } }),
        F(`C${r}-L${r}`, util, M0, { font: { bold: true } }, util < 0 ? ST.bad : null),
        F(`IF(C${r}>0,M${r}/C${r},0)`, mpct, P1),
        F(`C${r}-J${r}`, precio - cv, M0),
        F(`IF(C${r}>0,O${r}/C${r},0)`, precio > 0 ? (precio - cv) / precio : 0, P1),
        F(`IF(${P.meta}<1,L${r}/(1-${P.meta}),0)`, total / (1 - meta), M0),
        C(Math.round(vp.cantMes), '#,##0', ST.inp),
        C(vp.pctVend, P1, ST.inp),
        F(`M${r}*R${r}`, util * vp.cantMes, M0),
        F(`IF(M${r}<0,"PÉRDIDA",IF(N${r}<${P.meta},"Margen bajo","OK"))`, estado, null, stE)
      ]);
      resumenPanes.push({ masa: cat.nombre, nombre, precio, cv, total, util, mpct, cant: vp.cantMes, estado, lote: loteTxt[l.lineaId] || 0 });
    });
  });
  const pFin = SPn.rows.length;
  const ventasMix = resumenPanes.reduce((a, x) => a + x.precio * x.cant, 0);
  const cvMix = resumenPanes.reduce((a, x) => a + x.cv * x.cant, 0);
  SPn.add([C('TOTAL / PROMEDIO PONDERADO', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot),
    C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot), C('', null, ST.tot),
    F(`IF(SUMPRODUCT(C${pIni}:C${pFin},R${pIni}:R${pFin})>0,SUMPRODUCT(O${pIni}:O${pFin},R${pIni}:R${pFin})/SUMPRODUCT(C${pIni}:C${pFin},R${pIni}:R${pFin}),0)`, ventasMix > 0 ? (ventasMix - cvMix) / ventasMix : 0, P1, ST.tot),
    C('', null, ST.tot), F(`SUM(R${pIni}:R${pFin})`, resumenPanes.reduce((a, x) => a + x.cant, 0), '#,##0', ST.tot), C('', null, ST.tot),
    F(`SUM(T${pIni}:T${pFin})`, resumenPanes.reduce((a, x) => a + x.util * x.cant, 0), M0, ST.tot), C('', null, ST.tot)]);
  SPn.add([]);
  [
    'Cómo leer: COSTO VARIABLE es lo que cuesta hacer el pan (sube con cada pan que haces). COSTO FIJO ASIGNADO es la parte de arriendo, servicios y nómina que le toca a ese pan.',
    'Margen de contribución = precio − costo variable: lo que deja cada pan para pagar los costos fijos. Si es negativo, ese pan pierde plata aunque vendas mucho.',
    'Precio sugerido = costo total ÷ (1 − margen objetivo). Es el precio para ganar el margen objetivo de la hoja Parámetros con el costo de hoy.',
    '% vendaje = panes regalados ÷ panes vendidos en los pedidos. Su costo se carga a los panes que sí se cobran.',
    'Los adicionales "fijos por producción" (ej: color por tanda) no se suman por pan: se ven en la hoja Adicionales.'
  ].forEach(t => { SPn.add([T('• ' + t, ST.nota)]); SPn.merges.push({ s: { r: SPn.rows.length - 1, c: 0 }, e: { r: SPn.rows.length - 1, c: 12 } }); });
  const sinCosteo = (DB.productos || []).filter(p => p.activo !== false && !costeados.has(p.id));
  if (sinCosteo.length) {
    SPn.add([]);
    SPn.add([T(`Productos del catálogo SIN costeo por masa (${sinCosteo.length}): ${sinCosteo.map(p => p.nombre).join(', ')}`, ST.nota)]);
    SPn.merges.push({ s: { r: SPn.rows.length - 1, c: 0 }, e: { r: SPn.rows.length - 1, c: 12 } });
  }

  /* ============ RESUMEN ============ */
  const SR = hoja();
  SR.cols = [46, 20, 20, 14, 14, 11];
  titulo(SR, `COSTEO DE PRODUCTOS · ${negocio}`, 6, `Exportado del panel el ${fechaTxt}. Celdas amarillas = supuestos editables (hoja Parámetros).`);
  const secR = (txt, ancho = 2) => { SR.add(Array.from({ length: ancho }, (_, i) => T(i ? '' : txt, ST.sec))); SR.merges.push({ s: { r: SR.rows.length - 1, c: 0 }, e: { r: SR.rows.length - 1, c: ancho - 1 } }); };
  secR('RESULTADO DEL MES (con la mezcla de ventas de los pedidos)');
  const kr = (lbl, cell) => { const r = SR.rows.length + 1; SR.add([C(lbl, null, ST.lbl), cell]); return r; };
  const rVm = kr('Ventas de los panes costeados', F(`SUMPRODUCT(${SH.pan}!C${pIni}:C${pFin},${SH.pan}!R${pIni}:R${pFin})`, ventasMix, M0, ST.big));
  const rCv = kr('Costo variable (masa, merma, adicionales, vendajes)', F(`SUMPRODUCT(${SH.pan}!J${pIni}:J${pFin},${SH.pan}!R${pIni}:R${pFin})`, cvMix, M0));
  const rMc = kr('Margen de contribución', F(`B${rVm}-B${rCv}`, ventasMix - cvMix, M0, { font: { bold: true } }));
  const mcPct = ventasMix > 0 ? (ventasMix - cvMix) / ventasMix : 0;
  const rMcp = kr('Margen de contribución %', F(`IF(B${rVm}>0,B${rMc}/B${rVm},0)`, mcPct, P1));
  const rCfm = kr('Costos fijos del mes (indirectos + nómina)', F(P.cf, cfMes, M0));
  const uOp = ventasMix - cvMix - cfMes;
  kr('UTILIDAD OPERATIVA DEL MES', F(`B${rMc}-B${rCfm}`, uOp, M0, ST.big, uOp < 0 ? ST.bad : ST.ok));
  SR.add([]);
  secR('PUNTO DE EQUILIBRIO');
  const pe = mcPct > 0 ? cfMes / mcPct : 0;
  const rPe = kr('Ventas necesarias al mes para no perder', F(`IF(B${rMcp}>0,B${rCfm}/B${rMcp},0)`, pe, M0, ST.big));
  kr('Ventas necesarias por día', F(`B${rPe}/${P.dias}`, pe / diasMes, M0));
  kr('Ventas promedio actuales al mes (pedidos)', F(P.ventas, ven.ventasMes, M0));
  kr('Te sobra (+) o te falta (−) para el equilibrio', F(`${P.ventas}-B${rPe}`, ven.ventasMes - pe, M0, { font: { bold: true } }, ven.ventasMes - pe < 0 ? ST.bad : ST.ok));
  SR.add([]);
  secR('ALERTAS');
  kr('Panes que dan PÉRDIDA', F(`COUNTIF(${SH.pan}!U${pIni}:U${pFin},"PÉRDIDA")`, resumenPanes.filter(x => x.estado === 'PÉRDIDA').length, '0', ST.bad));
  kr('Panes con margen bajo (menor al objetivo)', F(`COUNTIF(${SH.pan}!U${pIni}:U${pFin},"Margen bajo")`, resumenPanes.filter(x => x.estado === 'Margen bajo').length, '0', ST.warn));
  kr('Panes OK', F(`COUNTIF(${SH.pan}!U${pIni}:U${pFin},"OK")`, resumenPanes.filter(x => x.estado === 'OK').length, '0', ST.ok));
  // Ranking (valores del momento de exportar)
  const ranking = resumenPanes.slice().sort((a, b) => a.mpct - b.mpct);
  const top = (titulo2, lista) => {
    SR.add([]);
    secR(titulo2, 6);
    SR.add(['Pan', 'Masa', 'Precio', 'Costo total', 'Utilidad', 'Margen'].map(h => T(h, ST.head)));
    lista.forEach(x => SR.add([C(x.nombre, null, { font: { bold: true } }), C(x.masa), C(x.precio, M0), C(x.total, M0), C(x.util, M0, x.util < 0 ? ST.bad : null), C(x.mpct, P1, x.estado === 'PÉRDIDA' ? ST.bad : x.estado === 'OK' ? ST.ok : ST.warn)]));
  };
  if (ranking.length <= 10) top('TODOS LOS PANES, DEL QUE MENOS DEJA AL QUE MÁS DEJA', ranking);
  else {
    top('LOS 5 PANES QUE MENOS DEJAN (revisar precio o receta)', ranking.slice(0, 5));
    top('LOS 5 PANES QUE MÁS DEJAN', ranking.slice(-5).reverse());
  }
  SR.add([]);
  [
    'Este ranking es una foto del momento de exportar; las cifras de arriba sí se recalculan si cambias algo.',
    `Costos fijos repartidos por precio: cada pan carga ${coN(pctCF * 100, 1)}% de su precio en costos fijos (Parámetros).`,
    nominaEnIndirectos ? 'La nómina NO se sumó porque ya hay salarios en Costos indirectos (puedes cambiarlo en Parámetros).' : 'La nómina se sumó como costo fijo (puedes quitarla en Parámetros).'
  ].forEach(t => { SR.add([T('• ' + t, ST.nota)]); SR.merges.push({ s: { r: SR.rows.length - 1, c: 0 }, e: { r: SR.rows.length - 1, c: 5 } }); });

  /* ---------- libro ---------- */
  const wb = X.utils.book_new();
  [['Resumen', SR], ['Parámetros', SP], ['Panes', SPn], ['Masas', SM], ['Adicionales', SA], ['Insumos', SI], ['Costos fijos', SC]]
    .forEach(([n, S]) => X.utils.book_append_sheet(wb, aWs(S), n));
  wb.Workbook = { CalcPr: { fullCalcOnLoad: true } };
  X.writeFile(wb, `Costeo_${negocio.replace(/[^\wáéíóúñÁÉÍÓÚÑ ]/g, '').trim().replace(/\s+/g, '_')}_${fechaTxt}.xlsx`, { cellStyles: true });
  toast('Excel de costeo descargado', 'success');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * REGISTRO EN EL ERP
 * ═══════════════════════════════════════════════════════════════════════════ */

/* El router de index.html ya conoce la ruta y `refrescarVistaActiva` ya mapea
   el título "Costos y Rentabilidad" → 'costos', así que el Realtime repinta
   esta vista igual que todas las demás. */
ROUTES.costos = renderCostos;
