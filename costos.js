/* ============================================================================
 * costos.js · Módulo "Costos, Punto de Equilibrio y Rentabilidad"
 * ----------------------------------------------------------------------------
 * Se carga DESPUÉS del script principal de index.html, por lo que reutiliza sus
 * helpers globales ($, money, num, todayKey, modal, closeModal, toast, saveDB,
 * setHeader, DB, ROUTES) y toda la persistencia vive en `appwriteService`.
 *
 * Este archivo NO habla con Appwrite directamente: cero fetch, cero SDK.
 * Realtime ya está cubierto: appwriteService suscribe las tablas `insumos`,
 * `recetas`, `produccion` y `costos_indirectos` en la misma conexión WebSocket
 * y repinta la vista activa, así que los KPIs y gráficos se actualizan solos
 * cuando otro dispositivo cambia algo.
 *
 * MODELO DE COSTOS
 *   · Cada insumo se normaliza a una UNIDAD BASE (gramo, mililitro o unidad).
 *     precioBase = precioCompra / (cantidadComprada × factor)
 *   · Cada producto tiene UNA receta, expresada POR LATA.
 *     costoLata = Σ (cantidadBase_ingrediente × precioBase_insumo)
 *   · La producción se registra en LATAS.
 *     panes = latas × panesPorLata   ·   peso = panes × pesoPorPan
 *   · Los costos indirectos se prorratean a costo/día según su periodicidad.
 *   · Punto de equilibrio (modelo de margen de contribución):
 *       MC unitario = precio promedio de venta − costo variable por pan
 *       PE unidades = costos fijos del día / MC unitario
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

const CO_CAT_INSUMO = ['Harinas', 'Grasas', 'Azúcares', 'Lácteos', 'Levaduras', 'Huevos', 'Sal y aditivos', 'Rellenos', 'Empaques', 'Otros'];
const CO_CAT_INDIRECTO = ['Producción', 'Administración', 'Ventas', 'Transporte', 'Mantenimiento', 'Limpieza', 'Servicios públicos', 'Depreciaciones', 'Otros'];

/** Divisor para prorratear cualquier periodicidad a COSTO POR DÍA. */
const CO_DIAS = { diario: 1, semanal: 7, quincenal: 15, mensual: 30, anual: 365 };

const CO_COLORS = ['#3525cd', '#00897b', '#f9a825', '#e53935', '#8e24aa', '#1e88e5', '#43a047', '#fb8c00', '#6d4c41', '#546e7a'];

/* ═══════════════════════════════════════════════════════════════════════════
 * ESTADO DE LA VISTA
 * ═══════════════════════════════════════════════════════════════════════════ */

let _coTab = 'dashboard';
let _coFecha = todayKey();
let _coCharts = [];
let _coBusqueda = '';
/** Ingredientes en edición dentro del modal de receta (buffer temporal). */
let _coRecetaBuf = [];

/* ═══════════════════════════════════════════════════════════════════════════
 * MOTOR DE CÁLCULO — funciones puras, sin efectos secundarios
 * ═══════════════════════════════════════════════════════════════════════════ */

const coNum = (v, d = 0) => (v === undefined || v === null || v === '' ? d : Number(v) || d);

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
/** @returns {object|null} Receta de un producto. */
const coReceta = (productoId) => DB.costos.recetas.find(r => r.productoId === productoId) || null;

/**
 * Costo total de UNA lata según la receta vigente y los precios de HOY.
 * Si un insumo fue borrado, ese ingrediente aporta 0 y se reporta como faltante.
 * @param {object|null} receta
 * @returns {{costoLata:number, faltantes:string[], detalle:Array}}
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

/**
 * Métricas de costo de un producto, derivadas de su receta.
 * @param {string} productoId
 */
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

/**
 * Fotografía completa de un día: ventas, producción, costos, PE y rentabilidad.
 * Es la única fuente de verdad de los KPIs; el dashboard, el PE y los gráficos
 * consumen esto para que nunca se contradigan entre sí.
 * @param {string} fecha 'YYYY-MM-DD'
 */
function coDia(fecha) {
  /* --- Ventas (desde los pedidos ya existentes del ERP) --- */
  const pedidos = (DB.pedidos || []).filter(p => p.fecha === fecha);
  const ventasBrutas = pedidos.reduce((a, p) => a + coNum(p.total), 0);
  const unidadesVendidas = pedidos.reduce(
    (a, p) => a + (p.items || []).reduce((b, i) => b + coNum(i.cantidad), 0), 0);
  // Los vendajes son producto entregado sin cobrar: reducen la venta neta.
  const vendajes = pedidos.reduce(
    (a, p) => a + (p.items || []).reduce((b, i) => b + coNum(i.vendajes), 0), 0);
  const valorVendajes = pedidos.reduce(
    (a, p) => a + (p.items || []).reduce((b, i) => b + coNum(i.vendajes) * coNum(i.precio), 0), 0);
  const ventasNetas = ventasBrutas - valorVendajes;

  /* --- Producción del día (en latas) --- */
  const prod = (DB.costos.produccion || []).filter(p => p.fecha === fecha);
  let latas = 0, panes = 0, pesoG = 0, costoMP = 0;
  const porProducto = [];

  for (const r of prod) {
    const m = coMetricasProducto(r.productoId);
    // El costo por lata se congela al registrar la producción (costoLata guardado).
    // Si no se guardó, se usa el costo vigente de la receta.
    const cl = coNum(r.costoLata) > 0 ? coNum(r.costoLata) : m.costoLata;
    const ppl = Math.max(1, coNum(r.panesPorLata, m.panesPorLata));
    const ppp = coNum(r.pesoPorPan, m.pesoPorPan);
    const nPanes = coNum(r.latas) * ppl;

    latas += coNum(r.latas);
    panes += nPanes;
    pesoG += nPanes * ppp;
    costoMP += coNum(r.latas) * cl;

    porProducto.push({
      registroId: r.id,
      productoId: r.productoId,
      nombre: DB.productos.find(p => p.id === r.productoId)?.nombre || '(producto eliminado)',
      latas: coNum(r.latas), panesPorLata: ppl, pesoPorPan: ppp,
      panes: nPanes, pesoKg: (nPanes * ppp) / 1000,
      costoLata: cl, costoTotal: coNum(r.latas) * cl,
      costoPorPan: ppl > 0 ? cl / ppl : 0
    });
  }

  /* --- Costos --- */
  const costoIndirecto = coIndirectoDiario();
  const costoTotal = costoMP + costoIndirecto;

  /* --- Resultado --- */
  const utilidad = ventasNetas - costoTotal;
  const margen = ventasNetas > 0 ? (utilidad / ventasNetas) * 100 : 0;
  const rentabilidad = costoTotal > 0 ? (utilidad / costoTotal) * 100 : 0;

  /* --- Punto de equilibrio (margen de contribución) --- */
  const precioProm = unidadesVendidas > 0 ? ventasNetas / unidadesVendidas : 0;
  const costoVarUnit = panes > 0 ? costoMP / panes : 0;   // materia prima por pan producido
  const mcUnitario = precioProm - costoVarUnit;
  const peUnidades = mcUnitario > 0 ? costoIndirecto / mcUnitario : 0;
  const pePesos = peUnidades * precioProm;
  const superoPE = ventasNetas >= pePesos && pePesos > 0;
  const brechaPE = ventasNetas - pePesos;

  /* --- Semáforo --- */
  let estado = 'equilibrio', estadoTxt = 'Punto de equilibrio', estadoIcon = '🟡';
  if (utilidad > 0.005 * Math.max(1, ventasNetas)) { estado = 'rentable'; estadoTxt = 'Rentable'; estadoIcon = '🟢'; }
  else if (utilidad < -0.005 * Math.max(1, ventasNetas)) { estado = 'perdida'; estadoTxt = 'Pérdida'; estadoIcon = '🔴'; }
  if (ventasNetas === 0 && costoTotal === 0) { estado = 'vacio'; estadoTxt = 'Sin datos'; estadoIcon = '⚪'; }

  return {
    fecha, pedidos: pedidos.length,
    ventasBrutas, ventasNetas, valorVendajes, vendajes, unidadesVendidas,
    latas, panes, pesoKg: pesoG / 1000, porProducto,
    costoMP, costoIndirecto, costoTotal,
    utilidad, margen, rentabilidad,
    precioProm, costoVarUnit, mcUnitario, peUnidades, pePesos, superoPE, brechaPE,
    costoPromedioPan: panes > 0 ? costoMP / panes : 0,
    costoPromedioLata: latas > 0 ? costoMP / latas : 0,
    estado, estadoTxt, estadoIcon
  };
}

/** Devuelve los últimos N días (incluye hoy) como array de 'YYYY-MM-DD'. */
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
  const conVentas7 = dias7.filter(x => x.ventasNetas > 0);
  const conVentas30 = dias30.filter(x => x.ventasNetas > 0);

  /* Estado general */
  if (d.estado === 'rentable') out.push({ tipo: 'ok', txt: `El día cerró con utilidad de ${money(d.utilidad)} (margen ${d.margen.toFixed(1)}%).` });
  else if (d.estado === 'perdida') out.push({ tipo: 'bad', txt: `El día cerró en pérdida por ${money(Math.abs(d.utilidad))}. Los costos superaron las ventas netas.` });
  else if (d.estado === 'equilibrio' && d.ventasNetas > 0) out.push({ tipo: 'warn', txt: 'El día quedó prácticamente en punto de equilibrio: ni gana ni pierde.' });

  /* Punto de equilibrio */
  if (d.pePesos > 0) {
    if (d.superoPE) out.push({ tipo: 'ok', txt: `Se superó el punto de equilibrio (${money(d.pePesos)}) con un excedente de ${money(d.brechaPE)}.` });
    else out.push({ tipo: 'bad', txt: `No se alcanzó el punto de equilibrio: faltaron ${money(Math.abs(d.brechaPE))} en ventas.` });
  } else if (d.mcUnitario <= 0 && d.unidadesVendidas > 0) {
    out.push({ tipo: 'bad', txt: 'El margen de contribución por pan es cero o negativo: cada unidad vendida cuesta más de lo que deja. Revisa precios de venta o costo de receta.' });
  }

  /* Producción */
  if (d.panes > 0) {
    out.push({ tipo: 'info', txt: `Hoy se produjeron ${num(d.panes)} panes en ${num(d.latas)} latas (${num(d.pesoKg, 1)} kg).` });
    out.push({ tipo: 'info', txt: `El costo promedio por pan fue de ${money(d.costoPromedioPan)}.` });
  }

  /* Comparativo de costo por pan vs promedio de la semana */
  const prevPan = conVentas7.filter(x => x.fecha !== d.fecha && x.panes > 0);
  if (d.panes > 0 && prevPan.length >= 2) {
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
        txt: `${ins.nombre} ${v > 0 ? 'aumentó' : 'bajó'} un ${Math.abs(v).toFixed(1)}% en su última compra.`
      });
    }
  });

  /* Margen vs promedio semanal y mensual */
  const otros7 = conVentas7.filter(x => x.fecha !== d.fecha);
  if (d.ventasNetas > 0 && otros7.length >= 2) {
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
  if (d.ventasNetas > 0 && otros30.length >= 5) {
    const promU = otros30.reduce((a, x) => a + x.utilidad, 0) / otros30.length;
    if (Math.abs(d.utilidad - promU) > Math.max(1000, Math.abs(promU) * 0.1)) {
      out.push({
        tipo: d.utilidad >= promU ? 'ok' : 'warn',
        txt: `La utilidad de hoy fue ${d.utilidad >= promU ? 'superior' : 'inferior'} al promedio de los últimos 30 días (${money(promU)}).`
      });
    }
  }

  /* Recetas incompletas */
  const sinReceta = DB.productos.filter(p => p.activo && !coReceta(p.id));
  if (sinReceta.length) {
    out.push({ tipo: 'warn', txt: `${sinReceta.length} producto(s) activos no tienen receta: sus costos no entran en ningún cálculo.` });
  }

  if (!out.length) out.push({ tipo: 'info', txt: 'Todavía no hay datos suficientes para sacar conclusiones. Registra insumos, recetas y producción.' });
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

  const d = coDia(_coFecha);
  const tabs = [
    ['dashboard', 'Dashboard'], ['insumos', 'Insumos'], ['recetas', 'Recetas'],
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
      <div><h1>Costos y Rentabilidad</h1><div class="sub">Materia prima, producción por latas, punto de equilibrio y utilidad real</div></div>
      <div class="h-spacer"></div>
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

function coTabDashboard(d) {
  const ins = coInsights(d);
  const colorEstado = { rentable: 'var(--tertiary)', equilibrio: '#f9a825', perdida: 'var(--error)', vacio: 'var(--on-surface-variant)' }[d.estado];

  return `
    <div class="card mb-md" style="border-left:6px solid ${colorEstado}">
      <div class="card-b flex fb" style="flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:26px;font-weight:800;color:${colorEstado}">${d.estadoIcon} ${d.estadoTxt}</div>
          <div class="muted" style="font-size:12px">${_coFecha} · ${d.pedidos} pedido(s) · ${num(d.panes)} panes producidos</div>
        </div>
        <div style="text-align:right">
          <div class="muted" style="font-size:11px">Utilidad del día</div>
          <div style="font-size:30px;font-weight:800;font-family:var(--font-mono);color:${colorEstado}">${money(d.utilidad)}</div>
        </div>
      </div>
    </div>

    <h3 class="mb-md">Ventas</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Ventas brutas', money(d.ventasBrutas), 'trending_up', 'kpi-ico-p')}
      ${coKpi('Ventas netas', money(d.ventasNetas), 'payments', 'kpi-ico-t', `menos ${money(d.valorVendajes)} en vendajes`)}
      ${coKpi('Unidades vendidas', num(d.unidadesVendidas), 'list_alt', 'kpi-ico-s')}
      ${coKpi('Precio promedio / pan', money(d.precioProm), 'balance', 'kpi-ico-p')}
    </div>

    <h3 class="mb-md">Producción</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Latas producidas', num(d.latas, 1), 'inventory_2', 'kpi-ico-s')}
      ${coKpi('Panes producidos', num(d.panes), 'cake', 'kpi-ico-t')}
      ${coKpi('Kilogramos producidos', num(d.pesoKg, 1) + ' kg', 'balance', 'kpi-ico-p')}
      ${coKpi('Costo promedio / pan', money(d.costoPromedioPan), 'savings', 'kpi-ico-s')}
    </div>

    <h3 class="mb-md">Costos y resultado</h3>
    <div class="grid grid-4 mb-md">
      ${coKpi('Materia prima', money(d.costoMP), 'trending_down', 'kpi-ico-e')}
      ${coKpi('Costos indirectos', money(d.costoIndirecto), 'account_balance', 'kpi-ico-e', 'prorrateo diario')}
      ${coKpi('Costo total', money(d.costoTotal), 'balance', 'kpi-ico-e')}
      ${coKpi('Punto de equilibrio', money(d.pePesos), 'swap_horiz', 'kpi-ico-p', d.pePesos > 0 ? (d.superoPE ? 'Superado ✓' : `Faltan ${money(Math.abs(d.brechaPE))}`) : 'Sin datos')}
    </div>
    <div class="grid grid-3 mb-lg">
      ${coKpi('Utilidad', money(d.utilidad), 'savings', 'kpi-ico-t')}
      ${coKpi('Margen sobre ventas', d.margen.toFixed(1) + '%', 'percent', 'kpi-ico-p')}
      ${coKpi('Rentabilidad sobre costo', d.rentabilidad.toFixed(1) + '%', 'trending_up', 'kpi-ico-t')}
    </div>

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
 * PESTAÑA 2 · INSUMOS
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabInsumos() {
  const q = _coBusqueda.toLowerCase();
  const lista = (DB.costos.insumos || [])
    .filter(i => !q || i.nombre.toLowerCase().includes(q) || (i.categoria || '').toLowerCase().includes(q))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return `
    <div class="flex gap mb-md" style="flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" onclick="coInsumoModal()"><span class="ms">add</span>Nuevo Insumo</button>
      <input placeholder="Buscar insumo o categoría..." value="${_coBusqueda}" oninput="_coBusqueda=this.value;coRefrescarTabla()" style="max-width:280px"/>
      <span class="muted" style="font-size:12px">${lista.length} insumo(s)</span>
    </div>
    ${lista.length === 0 ? '<div class="empty">Sin insumos. Agrega el primero para poder costear tus recetas.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Insumo</th><th>Categoría</th><th>Compra</th><th>Precio compra</th>
      <th>Precio unitario</th><th>Precio / kg</th><th>Última variación</th><th>Proveedor</th><th></th>
    </tr></thead><tbody>
      ${lista.map(i => {
        const h = i.historial || [];
        const v = h.length >= 2 ? coNum(h[h.length - 1].variacion) : 0;
        const base = coBaseLabel(i.unidadCompra);
        const porKg = base === 'und' ? null : coNum(i.precioBase) * 1000;
        return `<tr>
          <td class="bold">${i.nombre}</td>
          <td><span class="badge">${i.categoria || '-'}</span></td>
          <td class="num">${num(i.cantidadComprada, 2)} ${i.unidadCompra}</td>
          <td class="num">${money(i.precioCompra)}</td>
          <td class="num bold">$${num(i.precioBase, 4)} <span class="muted">/ ${base}</span></td>
          <td class="num">${porKg === null ? '-' : money(porKg)}</td>
          <td>${h.length < 2 ? '<span class="muted">-</span>' :
            `<span class="badge ${v > 0 ? 'badge-error' : v < 0 ? 'badge-success' : ''}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`}</td>
          <td>${i.proveedor || '-'}</td>
          <td>
            <button class="btn btn-ghost btn-sm" title="Historial de precios" onclick="coHistorialInsumo('${i.id}')"><span class="ms">history</span></button>
            <button class="btn btn-ghost btn-sm" onclick="coInsumoModal('${i.id}')"><span class="ms">edit</span></button>
            <button class="btn btn-danger btn-sm" onclick="coDelInsumo('${i.id}')"><span class="ms">delete</span></button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`}`;
}

/** Repinta solo el cuerpo de la pestaña, sin perder el foco del buscador. */
function coRefrescarTabla() {
  const cont = document.querySelector('#view .fade-in');
  if (!cont) return;
  const activo = document.activeElement;
  const pos = activo && activo.selectionStart;
  cont.innerHTML = _coTab === 'insumos' ? coTabInsumos() : cont.innerHTML;
  const nuevo = cont.querySelector('input[placeholder^="Buscar"]');
  if (nuevo) { nuevo.focus(); try { nuevo.setSelectionRange(pos, pos); } catch (e) { /* noop */ } }
}

function coInsumoModal(id) {
  const i = id ? coInsumo(id) : {
    nombre: '', categoria: 'Harinas', unidadCompra: 'kg', cantidadComprada: 0,
    precioCompra: 0, proveedor: '', fechaCompra: todayKey(), observaciones: ''
  };
  if (!i) return;

  modal(id ? 'Editar insumo' : 'Nuevo insumo', `
    <div class="field"><label>Nombre *</label><input id="ci-nombre" value="${i.nombre}" placeholder="Ej: Harina de trigo"/></div>
    <div class="gf">
      <div class="field"><label>Categoría</label>
        <select id="ci-cat">${CO_CAT_INSUMO.map(c => `<option ${i.categoria === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Proveedor</label><input id="ci-prov" value="${i.proveedor || ''}"/></div>
    </div>
    <div class="gf3">
      <div class="field"><label>Unidad de compra</label>
        <select id="ci-uni" onchange="coPreviewInsumo()">${CO_UNIDADES.map(u => `<option value="${u.v}" ${i.unidadCompra === u.v ? 'selected' : ''}>${u.l}</option>`).join('')}</select></div>
      <div class="field"><label>Cantidad comprada</label><input id="ci-cant" type="number" step="any" value="${i.cantidadComprada || ''}" oninput="coPreviewInsumo()"/></div>
      <div class="field"><label>Precio de compra ($)</label><input id="ci-precio" type="number" step="any" value="${i.precioCompra || ''}" oninput="coPreviewInsumo()"/></div>
    </div>
    <div class="gf">
      <div class="field"><label>Fecha de compra</label><input id="ci-fecha" type="date" value="${i.fechaCompra || todayKey()}"/></div>
      <div class="field"><label>Observaciones</label><input id="ci-obs" value="${i.observaciones || ''}"/></div>
    </div>
    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b">
      <div class="bold mb-sm">Cálculo automático</div>
      <div id="ci-preview" style="font-family:var(--font-mono);font-size:13px">—</div>
      <div class="muted mt-sm" style="font-size:11.5px">
        Todo se convierte a la unidad base (gramo, mililitro o unidad) para costear las recetas.
        Al cambiar el precio se guarda una nueva entrada en el historial: los precios anteriores nunca se pierden.
      </div>
    </div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarInsumo('${id || ''}')">Guardar</button>`);
  coPreviewInsumo();
}

function coPreviewInsumo() {
  const el = $('#ci-preview');
  if (!el) return;
  const uni = $('#ci-uni').value;
  const cant = coNum($('#ci-cant').value);
  const precio = coNum($('#ci-precio').value);
  const factor = CO_FACTOR[uni] ?? 1;
  const baseTotal = cant * factor;
  const base = coBaseLabel(uni);

  if (baseTotal <= 0 || precio <= 0) { el.textContent = 'Ingresa cantidad y precio para ver el cálculo.'; return; }
  const pb = precio / baseTotal;
  el.innerHTML = `
    Total en unidad base: <b>${num(baseTotal, 2)} ${base}</b><br>
    Precio por ${base}: <b>$${num(pb, 4)}</b>
    ${base !== 'und' ? `<br>Precio por kg / litro: <b>${money(pb * 1000)}</b>` : ''}`;
}

async function coGuardarInsumo(id) {
  const data = {
    nombre: $('#ci-nombre').value.trim(),
    categoria: $('#ci-cat').value,
    unidadCompra: $('#ci-uni').value,
    cantidadComprada: coNum($('#ci-cant').value),
    precioCompra: coNum($('#ci-precio').value),
    proveedor: $('#ci-prov').value.trim(),
    fechaCompra: $('#ci-fecha').value,
    observaciones: $('#ci-obs').value.trim()
  };
  if (!data.nombre) { toast('El nombre es obligatorio', 'error'); return; }
  if (data.cantidadComprada <= 0) { toast('La cantidad comprada debe ser mayor a 0', 'error'); return; }
  if (data.precioCompra <= 0) { toast('El precio de compra debe ser mayor a 0', 'error'); return; }

  try {
    await appwriteService.guardarInsumo(id ? { id, ...data } : data);
    saveDB(); closeModal(); renderCostos();
    toast('Insumo guardado · recetas recalculadas', 'success');
  } catch (e) { /* el servicio ya mostró el motivo real */ }
}

function coDelInsumo(id) {
  const i = coInsumo(id);
  if (!i) return;
  const usado = (DB.costos.recetas || []).filter(r => (r.ingredientes || []).some(g => g.insumoId === id));
  modal('Eliminar insumo', `
    <p>Se eliminará <b>${i.nombre}</b> y todo su historial de precios.</p>
    ${usado.length ? `<p class="mt-md" style="color:var(--error)"><b>Atención:</b> este insumo se usa en
      <b>${usado.length} receta(s)</b>. Esas recetas quedarán incompletas y su costo bajará artificialmente.</p>` : ''}`,
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
  modal(`Historial de precios · ${i.nombre}`, `
    ${h.length === 0 ? '<div class="empty">Sin historial todavía.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Fecha</th><th>Cantidad</th><th>Precio compra</th><th>Precio / ${base}</th><th>Variación</th>
    </tr></thead><tbody>
      ${h.map(x => {
        const v = coNum(x.variacion);
        return `<tr>
          <td>${x.fecha}</td>
          <td class="num">${num(x.cantidad, 2)} ${x.unidad}</td>
          <td class="num">${money(x.precioCompra)}</td>
          <td class="num bold">$${num(x.precioBase, 4)}</td>
          <td>${v === 0 ? '<span class="muted">—</span>' :
            `<span class="badge ${v > 0 ? 'badge-error' : 'badge-success'}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`}</td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`}
    <div class="muted mt-md" style="font-size:12px">Cada cambio de precio queda registrado aquí. Modificar el precio actual no borra el historial.</div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cerrar</button>`);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 3 · RECETAS  (una receta = una LATA)
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabRecetas() {
  const prods = DB.productos.filter(p => p.activo).sort((a, b) => a.orden - b.orden);
  return `
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px;line-height:1.6">
      <b>Cada receta se define POR LATA.</b> Indica cuánto insumo lleva una lata, cuántos panes salen de esa lata
      y cuánto pesa cada pan. Con eso el sistema deriva solo el costo por pan, por kilogramo y por lata.
      Cuando cambies el precio de un insumo, <b>todas las recetas se recalculan automáticamente</b>.
    </div></div>
    ${prods.length === 0 ? '<div class="empty">No hay productos activos.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Producto</th><th>Precio venta</th><th>Ingredientes</th><th>Costo / lata</th>
      <th>Panes / lata</th><th>Peso / pan</th><th>Costo / pan</th><th>Costo / kg</th><th>Margen unitario</th><th></th>
    </tr></thead><tbody>
      ${prods.map(p => {
        const m = coMetricasProducto(p.id);
        const sinReceta = !m.receta;
        const margen = coNum(p.precio) - m.costoPorPan;
        const margenPct = coNum(p.precio) > 0 ? (margen / coNum(p.precio)) * 100 : 0;
        return `<tr>
          <td class="bold">${p.nombre}</td>
          <td class="num">${money(p.precio)}</td>
          <td>${sinReceta ? '<span class="badge badge-warn">Sin receta</span>' :
            `${m.receta.ingredientes.length} insumo(s)${m.faltantes.length ? ` <span class="badge badge-error">${m.faltantes.length} faltante(s)</span>` : ''}`}</td>
          <td class="num bold">${sinReceta ? '-' : money(m.costoLata)}</td>
          <td class="center">${sinReceta ? '-' : num(m.panesPorLata)}</td>
          <td class="num">${sinReceta ? '-' : num(m.pesoPorPan, 1) + ' g'}</td>
          <td class="num bold">${sinReceta ? '-' : money(m.costoPorPan)}</td>
          <td class="num">${sinReceta || m.costoPorKg === 0 ? '-' : money(m.costoPorKg)}</td>
          <td>${sinReceta ? '-' : `<span class="bold" style="color:${margen > 0 ? 'var(--tertiary)' : 'var(--error)'}">${money(margen)} · ${margenPct.toFixed(0)}%</span>`}</td>
          <td>
            <button class="btn btn-ghost btn-sm" onclick="coRecetaModal('${p.id}')"><span class="ms">edit</span></button>
            ${m.receta ? `<button class="btn btn-danger btn-sm" onclick="coDelReceta('${m.receta.id}')"><span class="ms">delete</span></button>` : ''}
          </td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`}`;
}

function coRecetaModal(productoId) {
  const p = DB.productos.find(x => x.id === productoId);
  if (!p) return;
  const r = coReceta(productoId);
  _coRecetaBuf = r ? JSON.parse(JSON.stringify(r.ingredientes || [])) : [];

  if (!(DB.costos.insumos || []).length) {
    toast('Primero registra al menos un insumo', 'error');
    return;
  }

  modal(`Receta (por lata) · ${p.nombre}`, `
    <div class="gf">
      <div class="field"><label>Panes por lata *</label>
        <input id="cr-ppl" type="number" min="1" step="1" value="${r?.panesPorLata || 1}" oninput="coRecetaTotales()"/></div>
      <div class="field"><label>Peso por pan (gramos) *</label>
        <input id="cr-ppp" type="number" step="any" value="${r?.pesoPorPan || ''}" placeholder="Ej: 80" oninput="coRecetaTotales()"/></div>
    </div>
    <h3 class="mt-md mb-sm">Ingredientes de UNA lata</h3>
    <div class="gf3" style="align-items:end">
      <div class="field"><label>Insumo</label>
        <select id="cr-ins">${DB.costos.insumos.map(i => `<option value="${i.id}">${i.nombre} ($${num(i.precioBase, 4)}/${coBaseLabel(i.unidadCompra)})</option>`).join('')}</select></div>
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

/** Repinta la lista de ingredientes y los totales derivados del modal. */
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
              <td class="bold">${ins.nombre}</td>
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
      productoId, panesPorLata, pesoPorPan,
      ingredientes: _coRecetaBuf.map(g => ({ insumoId: g.insumoId, cantidad: coNum(g.cantidad) }))
    });
    saveDB(); closeModal(); renderCostos(); toast('Receta guardada', 'success');
  } catch (e) { /* toast ya mostrado */ }
}

function coDelReceta(id) {
  modal('Eliminar receta', '<p>El producto quedará sin costeo y no aportará costo de materia prima a la producción.</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelRecetaOk('${id}')">Eliminar</button>`);
}
async function coDelRecetaOk(id) {
  try { await appwriteService.eliminarReceta(id); saveDB(); closeModal(); renderCostos(); toast('Receta eliminada', 'success'); }
  catch (e) { /* toast ya mostrado */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PESTAÑA 4 · PRODUCCIÓN (en latas)
 * ═══════════════════════════════════════════════════════════════════════════ */

function coTabProduccion(d) {
  return `
    <div class="flex gap mb-md" style="flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" onclick="coProdModal()"><span class="ms">add</span>Registrar producción</button>
      <span class="muted" style="font-size:12px">Producción del ${_coFecha}</span>
    </div>
    <div class="grid grid-4 mb-md">
      ${coKpi('Latas', num(d.latas, 1), 'inventory_2', 'kpi-ico-s')}
      ${coKpi('Panes', num(d.panes), 'cake', 'kpi-ico-t')}
      ${coKpi('Kilogramos', num(d.pesoKg, 1) + ' kg', 'balance', 'kpi-ico-p')}
      ${coKpi('Costo materia prima', money(d.costoMP), 'trending_down', 'kpi-ico-e')}
    </div>
    ${d.porProducto.length === 0 ? '<div class="empty">Sin producción registrada este día.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Producto</th><th>Latas</th><th>Panes/lata</th><th>Peso/pan</th><th>Total panes</th>
      <th>Peso total</th><th>Costo/lata</th><th>Costo/pan</th><th>Costo total</th><th></th>
    </tr></thead><tbody>
      ${d.porProducto.map(r => `<tr>
        <td class="bold">${r.nombre}</td>
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
        <td class="num">${num(d.panes)}</td><td class="num">${num(d.pesoKg, 2)} kg</td>
        <td></td><td class="num">${money(d.costoPromedioPan)}</td><td class="num">${money(d.costoMP)}</td><td></td>
      </tr>
    </tbody></table></div>`}`;
}

function coProdModal() {
  const conReceta = DB.productos.filter(p => p.activo && coReceta(p.id));
  if (!conReceta.length) {
    toast('Ningún producto activo tiene receta. Créala primero en la pestaña Recetas.', 'error');
    return;
  }
  modal('Registrar producción', `
    <div class="field"><label>Fecha</label><input id="cp-fecha" type="date" value="${_coFecha}"/></div>
    <div class="field"><label>Producto *</label>
      <select id="cp-prod" onchange="coProdPreview()">${conReceta.map(p => `<option value="${p.id}">${p.nombre}</option>`).join('')}</select></div>
    <div class="gf3">
      <div class="field"><label>Cantidad de latas *</label><input id="cp-latas" type="number" step="any" min="0" value="1" oninput="coProdPreview()"/></div>
      <div class="field"><label>Panes por lata</label><input id="cp-ppl" type="number" min="1" step="1" oninput="coProdPreview()"/></div>
      <div class="field"><label>Peso por pan (g)</label><input id="cp-ppp" type="number" step="any" oninput="coProdPreview()"/></div>
    </div>
    <div class="muted" style="font-size:11.5px">Panes por lata y peso por pan vienen de la receta. Puedes ajustarlos <b>solo para este registro</b> sin tocar la receta.</div>
    <div class="card mt-md" style="background:var(--surface-container-low)"><div class="card-b">
      <div id="cp-preview" style="font-family:var(--font-mono);font-size:13px"></div>
    </div></div>
  `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="coGuardarProd()">Registrar</button>`);
  coProdSync();
}

/** Rellena panes/lata y peso/pan desde la receta al cambiar de producto. */
function coProdSync() {
  const m = coMetricasProducto($('#cp-prod').value);
  $('#cp-ppl').value = m.panesPorLata;
  $('#cp-ppp').value = m.pesoPorPan;
  coProdPreview();
}
function coProdPreview() {
  const pid = $('#cp-prod')?.value;
  if (!pid) return;
  const m = coMetricasProducto(pid);
  const latas = coNum($('#cp-latas').value);
  const ppl = Math.max(1, coNum($('#cp-ppl').value, m.panesPorLata));
  const ppp = coNum($('#cp-ppp').value, m.pesoPorPan);
  const panes = latas * ppl;
  const pesoKg = (panes * ppp) / 1000;
  const costoTotal = latas * m.costoLata;

  const el = $('#cp-preview');
  if (!el) return;
  el.innerHTML = `
    Costo de la lata (precios de hoy): <b>${money(m.costoLata)}</b><br>
    Total panes: <b>${num(panes)}</b><br>
    Peso total: <b>${num(pesoKg, 2)} kg</b><br>
    Costo total de materia prima: <b>${money(costoTotal)}</b><br>
    Costo por pan: <b>${money(ppl > 0 ? m.costoLata / ppl : 0)}</b><br>
    Costo por kilogramo: <b>${pesoKg > 0 ? money(costoTotal / pesoKg) : '—'}</b>
    ${m.faltantes.length ? `<br><span style="color:var(--error)">⚠ ${m.faltantes.length} insumo(s) de la receta ya no existen: el costo está incompleto.</span>` : ''}`;
}

async function coGuardarProd() {
  const productoId = $('#cp-prod').value;
  const m = coMetricasProducto(productoId);
  const latas = coNum($('#cp-latas').value);
  if (latas <= 0) { toast('La cantidad de latas debe ser mayor a 0', 'error'); return; }

  try {
    await appwriteService.guardarProduccion({
      fecha: $('#cp-fecha').value || todayKey(),
      productoId,
      latas,
      panesPorLata: Math.max(1, Math.round(coNum($('#cp-ppl').value, m.panesPorLata))),
      pesoPorPan: coNum($('#cp-ppp').value, m.pesoPorPan),
      costoLata: m.costoLata   // se congela el costo del momento
    });
    saveDB(); closeModal(); renderCostos(); toast('Producción registrada', 'success');
  } catch (e) { /* toast ya mostrado */ }
}

function coDelProd(id) {
  modal('Eliminar registro', '<p>Se eliminará este registro de producción y su costo dejará de contar en el día.</p>',
    `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
     <button class="btn btn-danger" onclick="coDelProdOk('${id}')">Eliminar</button>`);
}
async function coDelProdOk(id) {
  try { await appwriteService.eliminarProduccion(id); saveDB(); closeModal(); renderCostos(); toast('Registro eliminado', 'success'); }
  catch (e) { /* toast ya mostrado */ }
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
    </div></div>
    ${lista.length === 0 ? '<div class="empty">Sin costos indirectos. Sin ellos, el punto de equilibrio no se puede calcular.</div>' : `
    <div class="tw"><table class="d"><thead><tr>
      <th>Concepto</th><th>Categoría</th><th>Periodicidad</th><th>Valor</th><th>Costo / día</th><th>Estado</th><th></th>
    </tr></thead><tbody>
      ${lista.map(c => {
        const dia = coNum(c.valor) / (CO_DIAS[c.periodicidad] || 30);
        const act = c.activo !== false;
        return `<tr style="${act ? '' : 'opacity:.5'}">
          <td class="bold">${c.nombre}</td>
          <td><span class="badge">${c.categoria || 'Otros'}</span></td>
          <td>${c.periodicidad}</td>
          <td class="num">${money(c.valor)}</td>
          <td class="num bold">${money(dia)}</td>
          <td><span class="badge ${act ? 'badge-success' : ''}">${act ? 'Activo' : 'Inactivo'}</span></td>
          <td>
            <button class="btn btn-ghost btn-sm" title="${act ? 'Desactivar' : 'Activar'}" onclick="coToggleInd('${c.id}',${!act})"><span class="ms">${act ? 'visibility' : 'visibility'}</span></button>
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
    <div class="field"><label>Concepto *</label><input id="cx-nombre" value="${c.nombre}" placeholder="Ej: Arriendo del local"/></div>
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
    <div class="field"><label>Observaciones</label><input id="cx-obs" value="${c.observaciones || ''}"/></div>
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
  const ok = d.superoPE;
  const color = d.pePesos <= 0 ? 'var(--on-surface-variant)' : ok ? 'var(--tertiary)' : 'var(--error)';
  const compPct = d.costoTotal > 0 ? (d.costoMP / d.costoTotal) * 100 : 0;

  return `
    <div class="card mb-md" style="border-left:6px solid ${color}">
      <div class="card-b">
        ${d.pePesos <= 0 ? `
          <div style="font-size:20px;font-weight:800">No se puede calcular el punto de equilibrio</div>
          <div class="muted mt-sm" style="font-size:13px;line-height:1.6">
            Falta al menos uno de estos tres: <b>ventas del día</b> (pedidos registrados),
            <b>producción del día</b> (latas) o <b>costos indirectos</b> activos.
            ${d.mcUnitario <= 0 && d.unidadesVendidas > 0 ? '<br><b style="color:var(--error)">Además el margen de contribución por pan es negativo: el precio de venta no alcanza a cubrir la materia prima.</b>' : ''}
          </div>` : `
          <div style="font-size:22px;font-weight:800;color:${color}">
            ${ok ? '✓ Se superó el punto de equilibrio' : '✗ No se alcanzó el punto de equilibrio'}
          </div>
          <div class="mt-sm" style="font-size:15px">
            ${ok
              ? `Excedente sobre el punto de equilibrio: <b style="color:var(--tertiary);font-family:var(--font-mono)">${money(d.brechaPE)}</b>`
              : `Faltaron <b style="color:var(--error);font-family:var(--font-mono)">${money(Math.abs(d.brechaPE))}</b> en ventas netas.`}
          </div>`}
      </div>
    </div>

    <div class="grid grid-4 mb-md">
      ${coKpi('Costo materia prima', money(d.costoMP), 'trending_down', 'kpi-ico-e', `${compPct.toFixed(0)}% del costo total`)}
      ${coKpi('Costo indirecto (fijo)', money(d.costoIndirecto), 'account_balance', 'kpi-ico-e', `${(100 - compPct).toFixed(0)}% del costo total`)}
      ${coKpi('Costo total', money(d.costoTotal), 'balance', 'kpi-ico-e')}
      ${coKpi('Ventas netas del día', money(d.ventasNetas), 'payments', 'kpi-ico-t')}
    </div>
    <div class="grid grid-4 mb-md">
      ${coKpi('Utilidad', money(d.utilidad), 'savings', d.utilidad >= 0 ? 'kpi-ico-t' : 'kpi-ico-e')}
      ${coKpi('Margen sobre ventas', d.margen.toFixed(1) + '%', 'percent', 'kpi-ico-p')}
      ${coKpi('Rentabilidad sobre costo', d.rentabilidad.toFixed(1) + '%', 'trending_up', 'kpi-ico-t')}
      ${coKpi('Punto de equilibrio', money(d.pePesos), 'swap_horiz', 'kpi-ico-p', d.peUnidades > 0 ? `${num(d.peUnidades, 0)} unidades` : '')}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-h"><div class="card-t">Cómo se calculó</div></div>
        <div class="card-b" style="font-family:var(--font-mono);font-size:13px;line-height:2">
          Precio promedio de venta / pan &nbsp;=&nbsp; <b>${money(d.precioProm)}</b><br>
          Costo variable / pan (materia prima) &nbsp;=&nbsp; <b>${money(d.costoVarUnit)}</b><br>
          <span style="color:var(--outline)">──────────────────────────</span><br>
          Margen de contribución / pan &nbsp;=&nbsp; <b style="color:${d.mcUnitario > 0 ? 'var(--tertiary)' : 'var(--error)'}">${money(d.mcUnitario)}</b><br><br>
          Costos fijos del día &nbsp;=&nbsp; <b>${money(d.costoIndirecto)}</b><br>
          <span style="color:var(--outline)">──────────────────────────</span><br>
          PE en unidades = fijos ÷ margen = <b>${d.peUnidades > 0 ? num(d.peUnidades, 0) + ' panes' : '—'}</b><br>
          PE en pesos = unidades × precio = <b>${money(d.pePesos)}</b>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><div class="card-t">Ventas vs punto de equilibrio</div></div>
        <div class="card-b"><div class="chart-box" style="height:240px"><canvas id="pe-chart"></canvas></div></div>
      </div>
    </div>`;
}

function coPintarPE(d) {
  const cv = document.getElementById('pe-chart');
  if (!cv || typeof Chart === 'undefined') return;
  _coCharts.push(new Chart(cv.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Ventas netas', 'Punto de equilibrio', 'Costo total'],
      datasets: [{
        data: [d.ventasNetas, d.pePesos, d.costoTotal],
        backgroundColor: ['#00897b', '#f9a825', '#e53935'],
        borderRadius: 8
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)}` } } },
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
  ['cg1', 'Ventas vs Punto de Equilibrio', 'Si la línea de ventas va por encima, el día fue rentable'],
  ['cg2', 'Utilidad diaria', 'Verde arriba de cero, rojo abajo'],
  ['cg3', 'Rentabilidad diaria (%)', 'Utilidad sobre costo total'],
  ['cg4', 'Costo de materia prima', 'Lo que se consumió en producción'],
  ['cg5', 'Costos indirectos por categoría', 'Prorrateo diario vigente'],
  ['cg6', 'Composición de costos', 'Materia prima vs costos indirectos'],
  ['cg7', 'Producción diaria (panes)', 'Unidades producidas por día'],
  ['cg8', 'Kilogramos producidos', 'Peso total de la producción'],
  ['cg9', 'Latas producidas', 'Volumen de horneado'],
  ['cg10', 'Costo promedio por pan', 'Cuánto cuesta producir una unidad']
];

function coTabAnalitica() {
  return `
    <div class="card mb-md" style="background:var(--surface-container-low)"><div class="card-b" style="font-size:12.5px">
      Ventana de análisis: <b>últimos 30 días</b> hasta el ${_coFecha}. Todos los gráficos se recalculan
      automáticamente cuando cambian ventas, producción, insumos o costos, en este y en los demás dispositivos.
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

function coPintarGraficos() {
  if (typeof Chart === 'undefined') { toast('No se pudo cargar la librería de gráficos', 'error'); return; }
  coDestruirGraficos();

  const fechas = coUltimosDias(30);
  const dias = fechas.map(coDia);
  const etiq = fechas.map(f => f.slice(8, 10) + '/' + f.slice(5, 7));
  const hayAlgo = dias.some(d => d.ventasNetas > 0 || d.panes > 0);

  /* 1 · Ventas vs PE */
  coChart('cg1', {
    type: 'line',
    data: {
      labels: etiq, datasets: [
        { label: 'Ventas netas', data: dias.map(d => d.ventasNetas), borderColor: '#00897b', backgroundColor: 'rgba(0,137,123,.12)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2 },
        { label: 'Punto de equilibrio', data: dias.map(d => d.pePesos), borderColor: '#f9a825', borderDash: [6, 4], tension: .3, borderWidth: 2, pointRadius: 0, fill: false }
      ]
    },
    options: coOpts()
  }, hayAlgo);

  /* 2 · Utilidad diaria */
  coChart('cg2', {
    type: 'bar',
    data: {
      labels: etiq, datasets: [{
        label: 'Utilidad', data: dias.map(d => d.utilidad),
        backgroundColor: dias.map(d => d.utilidad >= 0 ? '#00897b' : '#e53935'), borderRadius: 4
      }]
    },
    options: coOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)}` } } } })
  }, hayAlgo);

  /* 3 · Rentabilidad diaria (%) */
  coChart('cg3', {
    type: 'line',
    data: { labels: etiq, datasets: [{ label: 'Rentabilidad', data: dias.map(d => Number(d.rentabilidad.toFixed(1))), borderColor: '#3525cd', backgroundColor: 'rgba(53,37,205,.12)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y}%` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => v + '%' }, grid: { color: '#e5e7eb' } } }
    })
  }, hayAlgo);

  /* 4 · Costo de materia prima */
  coChart('cg4', {
    type: 'bar',
    data: { labels: etiq, datasets: [{ label: 'Materia prima', data: dias.map(d => d.costoMP), backgroundColor: '#e53935', borderRadius: 4 }] },
    options: coOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)}` } } } })
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
  const totMP = dias.reduce((a, d) => a + d.costoMP, 0);
  const totCI = dias.reduce((a, d) => a + d.costoIndirecto, 0);
  coChart('cg6', {
    type: 'doughnut',
    data: { labels: ['Materia prima', 'Costos indirectos'], datasets: [{ data: [totMP, totCI], backgroundColor: ['#e53935', '#3525cd'], borderWidth: 2, borderColor: '#fff' }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '55%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#000', font: { weight: '700' }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: c => {
              const t = totMP + totCI;
              return ` ${c.label}: ${money(c.parsed)} (${t > 0 ? ((c.parsed / t) * 100).toFixed(1) : 0}%)`;
            }
          }
        }
      }
    }
  }, totMP + totCI > 0);

  /* 7 · Producción diaria (panes) */
  coChart('cg7', {
    type: 'bar',
    data: { labels: etiq, datasets: [{ label: 'Panes', data: dias.map(d => d.panes), backgroundColor: '#3525cd', borderRadius: 4 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${num(c.parsed.y)} panes` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' }, precision: 0 }, grid: { color: '#e5e7eb' } } }
    })
  }, dias.some(d => d.panes > 0));

  /* 8 · Kilogramos producidos */
  coChart('cg8', {
    type: 'line',
    data: { labels: etiq, datasets: [{ label: 'Kilogramos', data: dias.map(d => Number(d.pesoKg.toFixed(1))), borderColor: '#8e24aa', backgroundColor: 'rgba(142,36,170,.12)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y} kg` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' }, callback: v => v + ' kg' }, grid: { color: '#e5e7eb' } } }
    })
  }, dias.some(d => d.pesoKg > 0));

  /* 9 · Latas producidas */
  coChart('cg9', {
    type: 'bar',
    data: { labels: etiq, datasets: [{ label: 'Latas', data: dias.map(d => d.latas), backgroundColor: '#fb8c00', borderRadius: 4 }] },
    options: coOpts({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${num(c.parsed.y, 1)} latas` } } },
      scales: { x: { ticks: { color: '#000', font: { weight: '600' }, maxTicksLimit: 10 }, grid: { display: false } }, y: { ticks: { color: '#000', font: { weight: '600' } }, grid: { color: '#e5e7eb' } } }
    })
  }, dias.some(d => d.latas > 0));

  /* 10 · Costo promedio por pan */
  coChart('cg10', {
    type: 'line',
    data: { labels: etiq, datasets: [{ label: 'Costo / pan', data: dias.map(d => Number(d.costoPromedioPan.toFixed(0))), borderColor: '#546e7a', backgroundColor: 'rgba(84,110,122,.14)', fill: true, tension: .3, borderWidth: 3, pointRadius: 2, spanGaps: true }] },
    options: coOpts({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${money(c.parsed.y)} por pan` } } } })
  }, dias.some(d => d.costoPromedioPan > 0));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * REGISTRO EN EL ERP
 * ═══════════════════════════════════════════════════════════════════════════ */

/* El router de index.html ya conoce la ruta y `refrescarVistaActiva` ya mapea
   el título "Costos y Rentabilidad" → 'costos', así que el Realtime repinta
   esta vista igual que todas las demás. */
ROUTES.costos = renderCostos;
