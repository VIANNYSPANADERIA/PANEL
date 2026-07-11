/* ============================================================================
 * appwriteService.js
 * ----------------------------------------------------------------------------
 * Capa de abstracción para Appwrite Tables (API moderna de Appwrite Cloud 2026).
 *
 * Usa EXCLUSIVAMENTE el servicio TablesDB:
 *   - createRow / getRow / listRows / updateRow / upsertRow / deleteRow
 * No utiliza en absoluto la API legacy (Databases / collections / documents).
 *
 * Cada entidad del ERP vive en su propia tabla (una fila por registro).
 * El objeto `DB` global del index.html se sigue usando como CACHÉ en memoria,
 * pero el origen de la verdad es Appwrite Tables. Toda mutación escribe
 * directamente la fila correspondiente en la nube; el Realtime empuja los
 * cambios de otros dispositivos en milisegundos vía WebSocket.
 *
 * Requisitos del proyecto (Supabase → Appwrite): las funciones de alto nivel
 * devuelven objetos con la misma forma que usaba la interfaz, para que el
 * index.html NO tenga que modificarse. La importación futura de CSV desde
 * Supabase puede hacerse llamando a `appwriteService.importarFila(tabla, data)`.
 * ========================================================================== */

/* === Configuración: pega tus 4 valores de Appwrite Cloud ============
 * 1) cloud.appwrite.io  → Create Project  →  anota ENDPOINT y PROJECT ID
 * 2) Add Platform → Web → hostname (localhost + tu dominio)
 * 3) Databases → Create Database → anota DATABASE ID
 * 4) Crea las 12 tablas listadas en TABLE_IDS (Settings → Tables → Create Table)
 *    A cada tabla agrégale las columnas indicadas en el README migrated farther.
 *    Permissions: Users → Read + Create + Update + Delete (o any para pruebas).
 * ================================================================== */
const AW_CONFIG = {
  endpoint:    'https://sfo.cloud.appwrite.io/v1',
  projectId:   '6a5154080010ccc94b37',
  databaseId:  '6a515940002a7546cf06'
};

/* Mapa de tableId lógico → id real en Appwrite.
   POR DEFECTO usamos el mismo nombre como tableId. Si le pones otro nombre
   en la consola, cámbialo aquí. */
const TABLE_IDS = {
  clientes:           'clientes',
  productos:          'productos',
  pedidos:            'pedidos',
  recaudo:            'recaudo',
  cartera:            'cartera',
  empleados:          'empleados',
  nominaHistorial:    'nomina_historial',
  contaMovimientos:   'conta_movimientos',
  contaCategorias:    'conta_categorias',
  contaCuentas:       'conta_cuentas',
  contaTransferencias:'conta_transferencias',
  facturaConfig:      'factura_config'
};

/* Instancias del SDK (TablesDB + Realtime). Se inicializan con awInit(). */
let _awClient = null;
let _awTables = null;   // Appwrite.TablesDB
let _awRT     = null;    // Appwrite.Realtime
let _awReady  = false;
const _awSubs = {};      // suscripciones Realtime activas (para poder cancelar)

/* Indica que estamos aplicando un evento remoto (evita loops de push). */
let _awApplyingRemote = false;

/* ---------------------------------------------------------------------------
 * INICIALIZACIÓN
 * ------------------------------------------------------------------------- */
function awInit(){
  if(_awReady) return true;
  if(!window.Appwrite) { console.warn('SDK de Appwrite no cargado'); return false; }
  if(AW_CONFIG.projectId.startsWith('PON_') || AW_CONFIG.databaseId.startsWith('PON_')){
    console.info('appwriteService: credenciales sin configurar — modo local únicamente');
    return false;
  }
  try{
    const { Client, TablesDB, Realtime } = window.Appwrite;
    _awClient = new Client().setEndpoint(AW_CONFIG.endpoint).setProject(AW_CONFIG.projectId);
    _awTables = new TablesDB(_awClient);
    _awRT     = new Realtime(_awClient);
    _awReady  = true;
    return true;
  }catch(e){
    console.warn('appwriteService init error:', e);
    return false;
  }
}
function awIsReady(){ return _awReady; }

/* ---------------------------------------------------------------------------
 * HELPERS de mapeo (objeto de la app ⇄ fila de Appwrite Tables)
 * Appwrite Tables no soporta objetos anidados: las columnas complejas se
 * guardan como Strings (JSON) y se (de)serializan aquí. `$id` es el rowId.
 * ------------------------------------------------------------------------- */
function _j(v){ try{ return JSON.stringify(v ?? null); }catch(e){ return 'null'; } }
function _p(s, fb){ try{ const v = JSON.parse(s); return v === null ? fb : v; }catch(e){ return fb; } }

/* Convierte un row crudo de Appwrite → objeto del ERP (según la tabla). */
function rowToObj(table, row){
  if(!row) return null;
  const id = row.$id;
  switch(table){
    case 'clientes':
      return { id, nombre:row.nombre||'', tipo:row.tipo||'', telefono:row.telefono||'',
               direccion:row.direccion||'', color:row.color||'',
               lat: (row.lat === undefined || row.lat === null || row.lat === '') ? null : Number(row.lat),
               lng: (row.lng === undefined || row.lng === null || row.lng === '') ? null : Number(row.lng),
               orden: row.orden === undefined ? 0 : Number(row.orden),
               saldoInicial: row.saldoInicial === undefined ? undefined : Number(row.saldoInicial),
               tipoSaldo: row.tipoSaldo || undefined };
    case 'productos':
      return { id, nombre:row.nombre||'', precio:Number(row.precio)||0, imagen:row.imagen||'',
               activo: row.activo === undefined ? true : !!row.activo,
               orden: row.orden === undefined ? 0 : Number(row.orden),
               vendajeActivo: !!row.vendajeActivo, vendajePct:Number(row.vendajePct)||0,
               vendajeCada:Number(row.vendajeCada)||0, clienteExclusivo:row.clienteExclusivo||null };
    case 'pedidos':
      return { id, clienteId:row.clienteId||'', fecha:row.fecha||'', items:_p(row.items,[])||[],
               comentario:row.comentario||'', total:Number(row.total)||0,
               modoCondicion:row.modoCondicion||'condicion' };
    case 'recaudo':
      return { id, fecha:row.fecha||'', pedidoId:row.pedidoId||'', clienteId:row.clienteId||'',
               cliente:row.cliente||'', tipo:row.tipo||'', subtotal:Number(row.subtotal)||0,
               deuda:Number(row.deuda)||0, entregado:!!row.entregado, recibido:!!row.recibido,
               recaudado:!!row.recaudado, nequi:Number(row.nequi)||0,
               bancolombia:Number(row.bancolombia)||0, deudaPago:Number(row.deudaPago)||0,
               debeCliente:Number(row.debeCliente)||0, faltante:Number(row.faltante)||0,
               salida:Number(row.salida)||0, observacion:row.observacion||'',
               efectivo:Number(row.efectivo)||0, ..._p(row.detalles,{}) };
    case 'cartera':
      return { id, clienteId:row.clienteId||'', fecha:row.fecha||'', tipo:row.tipo||'',
               valor:Number(row.valor)||0, saldoAnterior:Number(row.saldoAnterior)||0,
               saldoActual:Number(row.saldoActual)||0, observacion:row.observacion||'' };
    case 'empleados':
      return { id, nombre:row.nombre||'', periodo:row.periodo||'semanal',
               salarioBase:Number(row.salarioBase)||0, calendario:_p(row.calendario,{})||{},
               adelantos:_p(row.adelantos,[])||[], pendientes:_p(row.pendientes,[])||[] };
    case 'nominaHistorial':
      return { id, ..._p(row.data,{})||{}, empleadoId:row.empleadoId||'' };
    case 'contaMovimientos':
      return { id, tipo:row.tipo||'', categoria:row.categoria||'', valor:Number(row.valor)||0,
               descripcion:row.descripcion||'', fecha:row.fecha||'' };
    case 'contaCategorias':
      return { id, nombre:row.nombre||'', tipo:row.tipo||'' };
    case 'contaCuentas':
      return { id, nombre:row.nombre||'', tipo:row.tipo||'', saldo:Number(row.saldo)||0 };
    case 'contaTransferencias':
      return { id, ..._p(row.data,{})||{} };
    case 'facturaConfig':
      return _p(row.data, null);
  }
  return { id, ...row };
}

/* Convierte un objeto del ERP → payload limpio para Appwrite (por tabla). */
function objToRow(table, obj){
  switch(table){
    case 'clientes':
      return { nombre:obj.nombre||'', tipo:obj.tipo||'', telefono:obj.telefono||'',
               direccion:obj.direccion||'', color:obj.color||'',
               lat: obj.lat===null||obj.lat===undefined?'':obj.lat,
               lng: obj.lng===null||obj.lng===undefined?'':obj.lng,
               orden: Number(obj.orden)||0,
               saldoInicial: obj.saldoInicial===undefined?'':obj.saldoInicial,
               tipoSaldo: obj.tipoSaldo||'' };
    case 'productos':
      return { nombre:obj.nombre||'', precio:Number(obj.precio)||0, imagen:obj.imagen||'',
               activo: !!obj.activo, orden:Number(obj.orden)||0,
               vendajeActivo:!!obj.vendajeActivo, vendajePct:Number(obj.vendajePct)||0,
               vendajeCada:Number(obj.vendajeCada)||0, clienteExclusivo:obj.clienteExclusivo||'' };
    case 'pedidos':
      return { clienteId:obj.clienteId||'', fecha:obj.fecha||'', items:_j(obj.items||[]),
               comentario:obj.comentario||'', total:Number(obj.total)||0,
               modoCondicion:obj.modoCondicion||'condicion' };
    case 'recaudo':
      return { fecha:obj.fecha||'', pedidoId:obj.pedidoId||'', clienteId:obj.clienteId||'',
               cliente:obj.cliente||'', tipo:obj.tipo||'', subtotal:Number(obj.subtotal)||0,
               deuda:Number(obj.deuda)||0, entregado:!!obj.entregado, recibido:!!obj.recibido,
               recaudado:!!obj.recaudado, nequi:Number(obj.nequi)||0,
               bancolombia:Number(obj.bancolombia)||0, deudaPago:Number(obj.deudaPago)||0,
               debeCliente:Number(obj.debeCliente)||0, faltante:Number(obj.faltante)||0,
               salida:Number(obj.salida)||0, observacion:obj.observacion||'',
               efectivo:Number(obj.efectivo)||0, detalles:_j(obj.detalles||{}) };
    case 'cartera':
      return { clienteId:obj.clienteId||'', fecha:obj.fecha||'', tipo:obj.tipo||'',
               valor:Number(obj.valor)||0, saldoAnterior:Number(obj.saldoAnterior)||0,
               saldoActual:Number(obj.saldoActual)||0, observacion:obj.observacion||'' };
    case 'empleados':
      return { nombre:obj.nombre||'', periodo:obj.periodo||'semanal',
               salarioBase:Number(obj.salarioBase)||0, calendario:_j(obj.calendario||{}),
               adelantos:_j(obj.adelantos||[]), pendientes:_j(obj.pendientes||[]) };
    case 'nominaHistorial':
      return { empleadoId:obj.empleadoId||obj.empId||'', data:_j(obj) };
    case 'contaMovimientos':
      return { tipo:obj.tipo||'', categoria:obj.categoria||'', valor:Number(obj.valor)||0,
               descripcion:obj.descripcion||'', fecha:obj.fecha||'' };
    case 'contaCategorias':
      return { nombre:obj.nombre||'', tipo:obj.tipo||'' };
    case 'contaCuentas':
      return { nombre:obj.nombre||'', tipo:obj.tipo||'', saldo:Number(obj.saldo)||0 };
    case 'contaTransferencias':
      return { data:_j(obj) };
    case 'facturaConfig':
      return { data:_j(obj) };
  }
  return { ...obj };
}

/* ---------------------------------------------------------------------------
 * CRUD GENÉRICO de bajo nivel (TablesDB)
 * ------------------------------------------------------------------------- */
async function _crearFila(table, data, rowId){
  const { ID, Query } = window.Appwrite;
  try{
    const row = await _awTables.createRow({
      databaseId: AW_CONFIG.databaseId,
      tableId: TABLE_IDS[table],
      rowId: rowId || ID.unique(),
      data: objToRow(table, data)
    });
    return rowToObj(table, row);
  }catch(e){
    _handleErr('crear ' + table, e);
    throw e;
  }
}

async function _actualizarFila(table, rowId, data){
  try{
    const row = await _awTables.updateRow({
      databaseId: AW_CONFIG.databaseId,
      tableId: TABLE_IDS[table],
      rowId,
      data: objToRow(table, data)
    });
    return rowToObj(table, row);
  }catch(e){
    _handleErr('actualizar ' + table, e);
    throw e;
  }
}

async function _upsertFila(table, rowId, data){
  try{
    const row = await _awTables.upsertRow({
      databaseId: AW_CONFIG.databaseId,
      tableId: TABLE_IDS[table],
      rowId,
      data: objToRow(table, data)
    });
    return rowToObj(table, row);
  }catch(e){
    _handleErr('upsert ' + table, e);
    throw e;
  }
}

async function _eliminarFila(table, rowId){
  try{
    await _awTables.deleteRow({ databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table], rowId });
  }catch(e){
    _handleErr('eliminar ' + table, e);
    throw e;
  }
}

/* listar con paginación automítica (hasta esperarAll). Soporta miles de filas. */
async function _listarTodo(table, queries){
  const { Query } = window.Appwrite;
  const out = [];
  let offset = 0;
  const PAGE = 2000; // Appwrite permite hasta 2000 por request
  while(true){
    try{
      const res = await _awTables.listRows({
        databaseId: AW_CONFIG.databaseId,
        tableId: TABLE_IDS[table],
        queries: [ Query.limit(PAGE), Query.offset(offset), ...(queries||[]) ]
      });
      for(const r of (res.rows||res.documents||[])) out.push(rowToObj(table, r));
      if(!res.rows || res.rows.length < PAGE) break;
      offset += PAGE;
      if(offset > 50000) break; // salvaguarda
    }catch(e){
      _handleErr('listar ' + table, e);
      break;
    }
  }
  return out;
}

async function _obtenerFila(table, rowId){
  try{
    const row = await _awTables.getRow({ databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS[table], rowId });
    return rowToObj(table, row);
  }catch(e){
    _handleErr('obtener ' + table, e);
    return null;
  }
}

/* Manejo central de errores: mensajes claros + texto original en consola. */
function _handleErr(accion, e){
  const msg = (e && e.message) ? e.message : String(e);
  console.warn(`Appwrite [${accion}]:`, e);
  if(typeof toast === 'function') toast('Error de red ('+accion+'): '+msg, 'error');
}

/* ---------------------------------------------------------------------------
 * CARGA INICIAL: trae TODAS las tablas y rellena el objeto `DB` en memoria.
 * Se llama una sola vez al arranque, antes de pintar la UI.
 * ------------------------------------------------------------------------- */
async function awCargarTodo(){
  if(!_awReady) return;
  const [clientes, productos, pedidos, recaudo, cartera, empleados, historial,
         movs, cats, cuentas, transf, fconfig] = await Promise.all([
    _listarTodo('clientes'),
    _listarTodo('productos'),
    _listarTodo('pedidos'),
    _listarTodo('recaudo'),
    _listarTodo('cartera'),
    _listarTodo('empleados'),
    _listarTodo('nominaHistorial'),
    _listarTodo('contaMovimientos'),
    _listarTodo('contaCategorias'),
    _listarTodo('contaCuentas'),
    _listarTodo('contaTransferencias'),
    _obtenerFilaFacturaConfig()
  ]);

  if(clientes && clientes.length)        DB.clientes = clientes;
  if(productos && productos.length)     DB.productos = productos.sort((a,b)=>a.orden-b.orden);
  if(pedidos)                           DB.pedidos = pedidos;
  // recaudo: reconstruye el objeto {fecha:{pedidoId:fila}}
  DB.recaudo = {};
  (recaudo||[]).forEach(r=>{ if(!DB.recaudo[r.fecha]) DB.recaudo[r.fecha]={}; DB.recaudo[r.fecha][r.pedidoId]=r; });
  if(cartera)                            DB.cartera = cartera;
  if(empleados && empleados.length)      DB.nomina.empleados = empleados;
  if(historial)                          DB.nomina.historial = historial;
  if(movs)                               DB.conta.movimientos = movs;
  if(cats)                               DB.conta.categorias = cats;
  if(cuentas)                            DB.conta.cuentas = cuentas;
  if(transf)                             DB.conta.transferencias = transf;
  if(fconfig) DB.facturaConfig = Object.assign({}, _getDefaultFacturaConfig(), fconfig);
}

async function _obtenerFilaFacturaConfig(){
  try{
    const { Query } = window.Appwrite;
    const res = await _awTables.listRows({
      databaseId: AW_CONFIG.databaseId, tableId: TABLE_IDS.facturaConfig,
      queries: [ Query.limit(1) ]
    });
    const rows = res.rows || [];
    if(!rows.length) return null;
    const obj = rowToObj('facturaConfig', rows[0]);
    if(obj) obj._rowId = rows[0].$id; // guardamos el rowId del único documento de config
    return obj;
  }catch(e){ _handleErr('facturaConfig get', e); return null; }
}

/* Helper: el default de facturaConfig está definido en index.html como
   `const _defaultFacturaConfig` (un snapshot inmutable del DB.facturaConfig
   inicial). Aquí devolvemos una copia profunda de ese snapshot; si por
   algún motivo no existiera, devolvemos {} (se fusiona con defaults). */
function _getDefaultFacturaConfig(){
  try{
    if(typeof _defaultFacturaConfig !== 'undefined' && _defaultFacturaConfig){
      return JSON.parse(JSON.stringify(_defaultFacturaConfig));
    }
  }catch(e){}
  return {};
}

/* ---------------------------------------------------------------------------
 * REALTIME: suscripción a todas las tablas. Cada evento actualiza el `DB`
 * en memoria y re-renderiza la vista activa (si el usuario NO está editando).
 * Devuelve función para cancelar todas las suscripciones.
 * ------------------------------------------------------------------------- */
function awIniciarRealtime(onChange){
  if(!_awReady || !_awRT) return ()=>{};
  const { Channel } = window.Appwrite;
  const tables = Object.keys(TABLE_IDS);
  tables.forEach(t=>{
    try{
      const ch = Channel.tablesdb(AW_CONFIG.databaseId).table(TABLE_IDS[t]).row();
      _awSubs[t] = _awRT.subscribe(ch, (event)=>{
        _aplicarEventoRealtime(t, event, onChange);
      });
    }catch(e){ console.warn('subscribe ' + t + ':', e); }
  });
  return ()=>{ Object.values(_awSubs).forEach(s=>{ try{ if(typeof s==='function') s(); }catch(e){} }); };
}

function _aplicarEventoRealtime(table, event, onChange){
  if(!event || !event.payload) return;
  // Evitamos loops cuando el evento fue causado por nuestra propia escritura.
  if(_awApplyingRemote) return;
  const ev = (event.events && event.events[0]) || '';
  const action = ev.split('.').pop(); // create | update | delete
  const obj = rowToObj(table, event.payload);
  const id = event.payload.$id;
  _awApplyingRemote = true;
  try{
    switch(table){
      case 'clientes':       _upsertArr(DB.clientes, id, obj, action); break;
      case 'productos':      _upsertArr(DB.productos, id, obj, action); DB.productos.sort((a,b)=>a.orden-b.orden); break;
      case 'pedidos':        _upsertArr(DB.pedidos, id, obj, action); break;
      case 'cartera':        _upsertArr(DB.cartera, id, obj, action); break;
      case 'empleados':      _upsertArr(DB.nomina.empleados, id, obj, action); break;
      case 'nominaHistorial':_upsertArr(DB.nomina.historial, id, obj, action); break;
      case 'contaMovimientos': _upsertArr(DB.conta.movimientos, id, obj, action); break;
      case 'contaCategorias':  _upsertArr(DB.conta.categorias, id, obj, action); break;
      case 'contaCuentas':     _upsertArr(DB.conta.cuentas, id, obj, action); break;
      case 'contaTransferencias': _upsertArr(DB.conta.transferencias, id, obj, action); break;
      case 'recaudo':
        if(action==='delete'){ if(DB.recaudo[obj.fecha]) delete DB.recaudo[obj.fecha][obj.pedidoId]; }
        else { if(!DB.recaudo[obj.fecha]) DB.recaudo[obj.fecha]={}; DB.recaudo[obj.fecha][obj.pedidoId]=obj; }
        break;
      case 'facturaConfig':
        if(obj) DB.facturaConfig = Object.assign({}, _getDefaultFacturaConfig(), obj);
        break;
    }
    if(typeof onChange === 'function') onChange();
  }catch(e){ console.warn('Realtime apply error:', e); }
  _awApplyingRemote = false;
}
function _upsertArr(arr, id, obj, action){
  const i = arr.findIndex(x=>x.id===id);
  if(action==='delete'){ if(i>=0) arr.splice(i,1); return; }
  if(i>=0) arr[i]=obj; else arr.push(obj);
}

/* Función de apoyo: marca que la próxima operación la estamos iniciando
 * nosotros (para SUPRIMIR el evento de Realtime que vuelve al instante).
 * Úsala así: awSetApplying(true); await awUpdate(...); awSetApplying(false); */
function awSetApplying(v){ _awApplyingRemote = v; }

/* ---------------------------------------------------------------------------
 * API de alto nivel — nombres legibles por entidad
 * La IU del index.html llama a estas funciones. Cada una:
 *   1) muta el `DB` local (cache instantánea)
 *   2) escribe/elimina la fila en Appwrite (async, try/catch)
 *   3) devuelve el objeto resultante
 * ------------------------------------------------------------------------- */
const appwriteService = {

  /* === CLIENTES === */
  async guardarCliente(data){
    let obj;
    if(data.id){
      obj = { ...DB.clientes.find(c=>c.id===data.id), ...data };
      Object.assign(DB.clientes.find(c=>c.id===data.id), obj);
      awSetApplying(true); try{ await _actualizarFila('clientes', data.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: data.id || _genId('C'), orden: DB.clientes.length, ...data };
      DB.clientes.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('clientes', obj, obj.id); obj = r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async eliminarCliente(id){
    // elimina también sus pedidos + filas de recaudo asociadas
    for(const p of DB.pedidos.filter(p=>p.clienteId===id))
      await appwriteService.eliminarPedido(p.id);
    DB.clientes = DB.clientes.filter(c=>c.id!==id);
    awSetApplying(true); try{ await _eliminarFila('clientes', id); } finally{ awSetApplying(false); }
  },
  async reordenarClientes(listaOrdenada){
    // actualiza el campo `orden` en cascada
    for(let i=0;i<listaOrdenada.length;i++){
      const c = listaOrdenada[i];
      if(c.orden === i) continue;
      c.orden = i;
      awSetApplying(true); try{ await _actualizarFila('clientes', c.id, c); } finally{ awSetApplying(false); }
    }
  },

  /* === PRODUCTOS === */
  async guardarProducto(data){
    let obj;
    if(data.id){
      obj = { ...DB.productos.find(p=>p.id===data.id), ...data };
      Object.assign(DB.productos.find(p=>p.id===data.id), obj);
      awSetApplying(true); try{ await _actualizarFila('productos', data.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: data.id || _genId('P'), activo:true, orden: DB.productos.length+1,
              vendajeActivo:false, vendajePct:0, vendajeCada:0, clienteExclusivo:null, ...data };
      DB.productos.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('productos', obj, obj.id); obj = r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async eliminarProducto(id){
    DB.productos = DB.productos.filter(p=>p.id!==id);
    awSetApplying(true); try{ await _eliminarFila('productos', id); } finally{ awSetApplying(false); }
  },
  async toggleProductoActivo(id, val){
    const p = DB.productos.find(x=>x.id===id); if(!p) return;
    p.activo = val;
    awSetApplying(true); try{ await _actualizarFila('productos', id, p); } finally{ awSetApplying(false); }
  },
  async reordenarProductos(lista){
    for(let i=0;i<lista.length;i++){ lista[i].orden = i+1; }
    for(const p of lista){
      awSetApplying(true); try{ await _actualizarFila('productos', p.id, p); } finally{ awSetApplying(false); }
    }
  },

  /* === PEDIDOS === */
  async guardarPedido(p){
    let obj;
    if(p.id){
      obj = { ...DB.pedidos.find(x=>x.id===p.id), ...p };
      Object.assign(DB.pedidos.find(x=>x.id===p.id), obj);
      awSetApplying(true); try{ await _actualizarFila('pedidos', p.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: p.id || _genId('P'), items:[], comentario:'', total:0, modoCondicion:'condicion', ...p };
      DB.pedidos.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('pedidos', obj, obj.id); obj = r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async editarPedido(id, patch){
    const p = DB.pedidos.find(x=>x.id===id); if(!p) return null;
    Object.assign(p, patch);
    awSetApplying(true); try{ await _actualizarFila('pedidos', id, p); } finally{ awSetApplying(false); }
    return p;
  },
  async eliminarPedido(id){
    const p = DB.pedidos.find(x=>x.id===id);
    if(p && DB.recaudo[p.fecha]) delete DB.recaudo[p.fecha][id];
    // elimina también la fila de recaudo asociada (si existe)
    if(p){ const r = DB.recaudo[p.fecha] && DB.recaudo[p.fecha][id];
      if(r) await appwriteService.eliminarRecaudo(r.id); }
    DB.pedidos = DB.pedidos.filter(x=>x.id!==id);
    awSetApplying(true); try{ await _eliminarFila('pedidos', id); } finally{ awSetApplying(false); }
  },
  async obtenerPedidos(fecha){
    if(fecha) return DB.pedidos.filter(p=>p.fecha===fecha);
    return DB.pedidos;
  },

  /* === RECAUDO (una fila por pedido+fecha) === */
  async guardarRecaudo(r){
    let obj;
    if(r.id){
      obj = { ...((DB.recaudo[r.fecha]||{})[r.id]||{}), ...r };
      if(DB.recaudo[obj.fecha]) DB.recaudo[obj.fecha][obj.pedidoId]=obj;
      awSetApplying(true); try{ await _actualizarFila('recaudo', r.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: r.id || _genId('R'), entregado:false, recibido:false, recaudado:false,
              deuda:0, nequi:0, bancolombia:0, deudaPago:0, debeCliente:0, faltante:0,
              salida:0, efectivo:0, observacion:'', ...r };
      if(!DB.recaudo[obj.fecha]) DB.recaudo[obj.fecha]={};
      DB.recaudo[obj.fecha][obj.pedidoId]=obj;
      awSetApplying(true); try{ const row = await _crearFila('recaudo', obj, obj.id); obj = row||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async editarRecaudo(id, patch){
    // localizar la fila por id en DB.recaudo (búsqueda)
    let found=null, fecha=null;
    for(const f in DB.recaudo){ for(const pid in DB.recaudo[f]){ if(DB.recaudo[f][pid].id===id){ found=DB.recaudo[f][pid]; fecha=f; } } }
    if(!found) return null;
    Object.assign(found, patch);
    awSetApplying(true); try{ await _actualizarFila('recaudo', id, found); } finally{ awSetApplying(false); }
    return found;
  },
  async eliminarRecaudo(id){
    // eliminar de la cache
    for(const f in DB.recaudo){ for(const pid in DB.recaudo[f]){ if(DB.recaudo[f][pid].id===id){ delete DB.recaudo[f][pid]; } } }
    awSetApplying(true); try{ await _eliminarFila('recaudo', id); } finally{ awSetApplying(false); }
  },
  async reiniciarRecaudoDia(fecha){
    const filas = Object.values(DB.recaudo[fecha]||{});
    delete DB.recaudo[fecha];
    for(const r of filas) await appwriteService.eliminarRecaudo(r.id);
  },

  /* === CARTERA === */
  async guardarMovCartera(m){
    const obj = { id: m.id || _genId('M'), fecha: m.fecha || new Date().toISOString(),
                  valor:0, saldoAnterior:0, saldoActual:0, observacion:'', ...m };
    DB.cartera.push(obj);
    awSetApplying(true); try{ const r = await _crearFila('cartera', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
  },
  async obtenerCarteraCliente(clienteId){
    if(clienteId) return DB.cartera.filter(m=>m.clienteId===clienteId);
    return DB.cartera;
  },

  /* === NÓMINA === */
  async guardarEmpleado(data){
    let obj;
    if(data.id){
      obj = { ...DB.nomina.empleados.find(e=>e.id===data.id), ...data };
      Object.assign(DB.nomina.empleados.find(e=>e.id===data.id), obj);
      awSetApplying(true); try{ await _actualizarFila('empleados', data.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: data.id || _genId('E'), periodo:'semanal', salarioBase:0,
              calendario:{}, adelantos:[], pendientes:[], ...data };
      DB.nomina.empleados.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('empleados', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async eliminarEmpleado(id){
    DB.nomina.empleados = DB.nomina.empleados.filter(e=>e.id!==id);
    awSetApplying(true); try{ await _eliminarFila('empleados', id); } finally{ awSetApplying(false); }
  },
  async editarEmpleado(id, patch){
    const e = DB.nomina.empleados.find(x=>x.id===id); if(!e) return;
    Object.assign(e, patch);
    awSetApplying(true); try{ await _actualizarFila('empleados', id, e); } finally{ awSetApplying(false); }
  },
  async guardarPagoNomina(historialEntry, empleadoActualizado){
    DB.nomina.historial.push(historialEntry);
    if(empleadoActualizado) Object.assign(DB.nomina.empleados.find(e=>e.id===historialEntry.empId)||{}, empleadoActualizado);
    awSetApplying(true);
    try{
      await _crearFila('nominaHistorial', { ...historialEntry, empleadoId: historialEntry.empId }, historialEntry.id || _genId('NH'));
      if(empleadoActualizado) await _actualizarFila('empleados', historialEntry.empId, DB.nomina.empleados.find(e=>e.id===historialEntry.empId));
    } finally{ awSetApplying(false); }
  },

  /* === CONTABILIDAD === */
  async guardarMovimientoContable(m){
    const obj = { id: m.id || _genId('MV'), fecha: new Date().toISOString().slice(0,10), ...m };
    DB.conta.movimientos.push(obj);
    awSetApplying(true); try{ const r = await _crearFila('contaMovimientos', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
  },
  async editarMovimientoContable(id, patch){
    const m = DB.conta.movimientos.find(x=>x.id===id); if(!m) return;
    Object.assign(m, patch);
    awSetApplying(true); try{ await _actualizarFila('contaMovimientos', id, m); } finally{ awSetApplying(false); }
  },
  async eliminarMovimientoContable(id){
    DB.conta.movimientos = DB.conta.movimientos.filter(m=>m.id!==id);
    awSetApplying(true); try{ await _eliminarFila('contaMovimientos', id); } finally{ awSetApplying(false); }
  },
  async guardarCategoriaContable(c){
    let obj;
    if(c.id){
      obj = { ...DB.conta.categorias.find(x=>x.id===c.id), ...c };
      Object.assign(DB.conta.categorias.find(x=>x.id===c.id), obj);
      awSetApplying(true); try{ await _actualizarFila('contaCategorias', c.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: c.id || _genId('CAT'), ...c };
      DB.conta.categorias.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('contaCategorias', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async eliminarCategoriaContable(id){
    DB.conta.categorias = DB.conta.categorias.filter(c=>c.id!==id);
    awSetApplying(true); try{ await _eliminarFila('contaCategorias', id); } finally{ awSetApplying(false); }
  },
  async guardarCuenta(c){
    let obj;
    if(c.id){
      obj = { ...DB.conta.cuentas.find(x=>x.id===c.id), ...c };
      Object.assign(DB.conta.cuentas.find(x=>x.id===c.id), obj);
      awSetApplying(true); try{ await _actualizarFila('contaCuentas', c.id, obj); } finally{ awSetApplying(false); }
    }else{
      obj = { id: c.id || _genId('CT'), saldo:0, ...c };
      DB.conta.cuentas.push(obj);
      awSetApplying(true); try{ const r = await _crearFila('contaCuentas', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
    }
    return obj;
  },
  async eliminarCuenta(id){
    DB.conta.cuentas = DB.conta.cuentas.filter(c=>c.id!==id);
    awSetApplying(true); try{ await _eliminarFila('contaCuentas', id); } finally{ awSetApplying(false); }
  },
  async guardarTransferencia(t){
    const obj = { id: t.id || _genId('TR'), fecha: new Date().toISOString().slice(0,10), ...t };
    DB.conta.transferencias.push(obj);
    // notar: los saldos de las cuentas también deben actualizarse aparte vía editarCuenta
    awSetApplying(true); try{ const r = await _crearFila('contaTransferencias', obj, obj.id); return r||obj; } finally{ awSetApplying(false); }
  },
  async editarCuenta(id, patch){
    const c = DB.conta.cuentas.find(x=>x.id===id); if(!c) return;
    Object.assign(c, patch);
    awSetApplying(true); try{ await _actualizarFila('contaCuentas', id, c); } finally{ awSetApplying(false); }
  },

  /* === FACTURA CONFIG (un solo row global con todo el JSON en la columna data) === */
  async guardarFacturaConfig(fconfig){
    DB.facturaConfig = Object.assign({}, DB.facturaConfig, fconfig);
    // rowId almacenado en _rowId la primera vez que se carga. Si no existe, se crea.
    awSetApplying(true);
    try{
      if(DB.facturaConfig._rowId){
        await _actualizarFila('facturaConfig', DB.facturaConfig._rowId, DB.facturaConfig);
      }else{
        const r = await _crearFila('facturaConfig', DB.facturaConfig, 'factura_config_global');
        if(r) DB.facturaConfig._rowId = 'factura_config_global';
      }
    }finally{ awSetApplying(false); }
  },

  /* === IMPORTACIÓN DE CSV desde Supabase ===
   * Recibe el nombre lógico de la tabla y un array de objetos (una fila cada uno).
   * Inserta en lote (una a una, respetando IDs). Devuelve {ok, fallidos}. */
  async importarFila(table, rows){
    let ok=0, fallidos=0;
    for(const r of (rows||[])){
      try{
        const rowId = r.id || _genId(table.slice(0,3).toUpperCase());
        await _crearFila(table, { ...r, id:rowId }, rowId);
        ok++;
      }catch(e){ fallidos++; console.warn('import fila fallida:', e, r); }
    }
    return { ok, fallidos };
  },

  /* === util === */
  _genId: _genId,
  _crearFila, _actualizarFila, _eliminarFila, _listarTodo, _obtenerFila,
  awInit, awCargarTodo, awIniciarRealtime, awSetApplying, awIsReady,
  TABLE_IDS, AW_CONFIG
};

/* Generador de IDs legibles (compatibles con los ya existentes en el ERP). */
function _genId(prefix){
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

/* Exponer globalmente para index.html (que no usa módulos). */
window.appwriteService = appwriteService;
window.awInit = awInit;
window.awCargarTodo = awCargarTodo;
window.awIniciarRealtime = awIniciarRealtime;
window.awSetApplying = awSetApplying;
window.awIsReady = awIsReady;
window.AW_CONFIG = AW_CONFIG;
window.TABLE_IDS = TABLE_IDS;