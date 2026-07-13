/* ============================================================================
 * appwriteConfig.js  ·  ÚNICO archivo que debes editar
 * ----------------------------------------------------------------------------
 * Configuración central del ERP Panadería sobre Appwrite Cloud (TablesDB).
 * No contiene lógica. Solo datos. Se carga ANTES de appwriteService.js.
 * ========================================================================== */
'use strict';

/**
 * Credenciales y parámetros de red.
 * @type {Readonly<{endpoint:string, projectId:string, databaseId:string,
 *                  maxRetries:number, timeoutMs:number, pageSize:number,
 *                  cacheTtlMs:number, echoGraceMs:number, resyncMs:number,
 *                  debug:boolean}>}
 */
const AW_CONFIG = Object.freeze({
  /* --- Appwrite Console → Overview: copia el endpoint EXACTO (ojo la región) --- */
  endpoint:   'https://sfo.cloud.appwrite.io/v1',
  projectId:  '6a5154080010ccc94b37',
  databaseId: '6a515940002a7546cf06',

  /* --- Red --- */
  maxRetries: 3,        // reintentos por operación (backoff exponencial)
  timeoutMs:  15000,    // corte con AbortController
  pageSize:   1000,     // filas por página al listar

  /* --- Caché en memoria --- */
  cacheTtlMs: 30000,    // TTL de las listas cacheadas

  /* --- Realtime --- */
  echoGraceMs: 1500,    // ventana en la que ignoramos el eco de nuestra escritura
  resyncMs:    25000,   // heartbeat: si el socket muere, resincroniza

  /* --- Diagnóstico --- */
  debug: false          // true = logs verbosos en consola
});

/**
 * Mapa: nombre lógico usado por la app → ID real de la tabla en Appwrite.
 * @type {Readonly<Record<string,string>>}
 */
const TABLE_IDS = Object.freeze({
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
  facturaConfig:       'factura_config'
});

/** Mapa inverso: ID real de la tabla → nombre lógico. */
const TABLE_BY_ID = Object.freeze(
  Object.fromEntries(Object.entries(TABLE_IDS).map(([k, v]) => [v, k]))
);

/** Row fijo donde vive la configuración de factura (documento único global). */
const FACTURA_CONFIG_ROW_ID = 'factura_config_global';

/* Exposición global (el proyecto no usa módulos ES). */
window.AW_CONFIG = AW_CONFIG;
window.TABLE_IDS = TABLE_IDS;
window.TABLE_BY_ID = TABLE_BY_ID;
window.FACTURA_CONFIG_ROW_ID = FACTURA_CONFIG_ROW_ID;
