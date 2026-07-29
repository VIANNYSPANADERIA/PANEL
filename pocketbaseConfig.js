/* ============================================================================
 * pocketbaseConfig.js · Configuración de PocketBase para el ERP Panadería
 * ----------------------------------------------------------------------------
 * ÚNICO archivo que editas si cambias de servidor. Sin lógica.
 * ========================================================================== */
'use strict';

const PB_CONFIG = Object.freeze({
  // URL de tu PocketBase. Cuando tengas SSL, cámbiala a https://tu-dominio
  url: 'https://viannyspanaderia.duckdns.org',

  // Credenciales del usuario del ERP (creado en PocketBase → users)
  // Se usan para iniciar sesión automáticamente si no hay sesión.
  maxRetries: 3,
  timeoutMs: 15000,
  pageSize: 500,
  cacheTtlMs: 30000,
  echoGraceMs: 1500,
  resyncMs: 25000,
  debug: false
});

/* Mapa: nombre lógico usado por la app → nombre real de la colección en PocketBase */
const PB_COLLECTIONS = Object.freeze({
  clientes:            'clientes',
  productos:           'productos',
  pedidos:             'pedidos',
  recaudo:             'recaudo',
  cartera:             'cartera',
  empleados:           'empleados',
  nominaHistorial:     'nomina_historial',
  contaMovimientos:    'conta_movimientos',
  contaCategorias:     'conta_categorias',
  contaCuentas:        'conta_cuentas',
  contaTransferencias: 'conta_transferencias',
  facturaConfig:       'factura_config',
  insumos:             'insumos',
  recetas:             'recetas',
  produccion:          'produccion',
  costosIndirectos:    'costos_indirectos',
  calendarioEventos:   'calendario_eventos'
});

const PB_BY_NAME = Object.freeze(
  Object.fromEntries(Object.entries(PB_COLLECTIONS).map(([k, v]) => [v, k]))
);

window.PB_CONFIG = PB_CONFIG;
window.PB_COLLECTIONS = PB_COLLECTIONS;
window.PB_BY_NAME = PB_BY_NAME;
