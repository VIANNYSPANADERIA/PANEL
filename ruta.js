/* ============================================================================
 * ruta.js · Módulo "Ruta Repartos"
 * ----------------------------------------------------------------------------
 * Se carga DESPUÉS del script principal de index.html y reutiliza sus helpers
 * globales ($, money, todayKey, modal, closeModal, toast, setHeader, go, DB,
 * ROUTES, editarClienteModal, guardarCliente).
 *
 * NO tiene datos propios: todo sale de lo que ya existe en el ERP.
 *   · Clientes y su ORDEN  → DB.clientes (el mismo arreglo que pinta la pestaña
 *     Clientes; ya viene ordenado por `orden`, que es lo que cambia al arrastrar).
 *   · Pedido activo de hoy → DB.pedidos con fecha === hoy y total > 0. En el ERP
 *     cancelar o dejar un pedido en 0 lo ELIMINA, así que no hay "estado".
 *   · Coordenadas          → cliente.lat / cliente.lng (ficha del cliente).
 *   · Punto de salida      → DB.facturaConfig.rutaOrigenLat / rutaOrigenLng
 *     (la configuración global del negocio, que ya se sincroniza sola).
 * El tiempo real ya lo cubre appwriteService: cuando cambia un cliente, un
 * pedido o la configuración, refrescarVistaActiva() vuelve a pintar esta vista.
 *
 * Lo único que se guarda aparte es qué casillas marcó el repartidor, y solo en
 * ESTE dispositivo (localStorage, por día): así dos repartidores pueden armar
 * rutas distintas sin pisarse.
 * ========================================================================== */
'use strict';

/* Google Maps URLs (https://developers.google.com/maps/documentation/urls/get-started#directions-action)
   admite como máximo 9 paradas intermedias (waypoints) + el destino = 10 paradas
   por enlace. En el navegador del celular (sin la app de Google Maps) el límite
   baja a 3 intermedias; con la app instalada, el enlace abre la app y aplica 9.
   Si se eligen más de 10, la ruta se parte en tramos: cada tramo arranca en la
   última parada del anterior. */
const RUTA_MAX_PARADAS = 10;

let _rutaFecha = todayKey();

/* ═══════════════════════════ DATOS ═══════════════════════════ */

/** Coordenadas válidas del cliente o null (acepta números guardados como texto). */
function rutaCoords(c) {
  if (!c || c.lat == null || c.lng == null || c.lat === '' || c.lng === '') return null;
  const lat = Number(c.lat), lng = Number(c.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;   // valor por defecto, no una ubicación real
  return { lat, lng };
}

/** Punto de salida configurado, o null si todavía no se ha configurado. */
function rutaOrigen() {
  const fc = DB.facturaConfig || {};
  return rutaCoords({ lat: fc.rutaOrigenLat, lng: fc.rutaOrigenLng });
}

/**
 * Clientes con pedido activo hoy, en el MISMO orden de la pestaña Clientes.
 * Se recorre DB.clientes (no los pedidos) justamente para heredar ese orden.
 */
function rutaClientesDelDia() {
  const hoy = _rutaFecha;
  const totalPorCliente = new Map();
  for (const p of DB.pedidos || []) {
    if (p.fecha !== hoy || !p.clienteId || !(Number(p.total) > 0)) continue;
    totalPorCliente.set(p.clienteId, (totalPorCliente.get(p.clienteId) || 0) + Number(p.total));
  }
  const lista = (DB.clientes || [])
    .filter(c => totalPorCliente.has(c.id))
    .map(c => ({ cliente: c, total: totalPorCliente.get(c.id), coords: rutaCoords(c) }));
  // Pedidos de hoy cuyo cliente ya no existe: no se pueden rutear, solo se informan.
  const idsClientes = new Set((DB.clientes || []).map(c => c.id));
  const huerfanos = [...totalPorCliente.keys()].filter(id => !idsClientes.has(id)).length;
  return { lista, huerfanos };
}

/* --- Selección del repartidor (solo este dispositivo, por día) --- */
const _rutaKey = () => 'erp_ruta_sel_' + _rutaFecha;
function rutaSeleccion() {
  try { return new Set(JSON.parse(localStorage.getItem(_rutaKey()) || '[]')); }
  catch (e) { return new Set(); }
}
function rutaGuardarSeleccion(set) {
  try { localStorage.setItem(_rutaKey(), JSON.stringify([...set])); } catch (e) { /* almacenamiento lleno o bloqueado */ }
}

/* ═══════════════════════════ VISTA ═══════════════════════════ */

function renderRuta() {
  setHeader('Ruta Repartos');
  // Si la página quedó abierta de un día para otro, se pasa al día nuevo.
  if (_rutaFecha !== todayKey()) _rutaFecha = todayKey();

  const { lista, huerfanos } = rutaClientesDelDia();
  const sel = rutaSeleccion();
  // Se limpia de la selección lo que ya no tiene pedido hoy (pedido eliminado).
  const vigentes = new Set(lista.map(x => x.cliente.id));
  for (const id of [...sel]) if (!vigentes.has(id)) sel.delete(id);
  rutaGuardarSeleccion(sel);

  const origen = rutaOrigen();
  const fechaLarga = new Date(_rutaFecha + 'T00:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  const sinCoords = lista.filter(x => !x.coords).length;

  $('#view').innerHTML = `
    <div class="ph">
      <div><h1>🚚 Ruta Repartos</h1><div class="sub">Clientes con pedido hoy (${fechaLarga}), en el mismo orden de la pestaña Clientes</div></div>
    </div>

    <div class="grid grid-3 mb-md">
      <div class="kpi"><div class="kpi-ico kpi-ico-p"><span class="ms">receipt_long</span></div>
        <div class="kpi-l">Pedidos activos hoy</div><div class="kpi-v">${lista.length}</div></div>
      <div class="kpi"><div class="kpi-ico kpi-ico-t"><span class="ms">check_circle</span></div>
        <div class="kpi-l">Seleccionados</div><div class="kpi-v" id="ruta-kpi-sel">${sel.size}</div></div>
      <div class="kpi"><div class="kpi-ico ${sinCoords ? 'kpi-ico-e' : 'kpi-ico-s'}"><span class="ms">${sinCoords ? 'wrong_location' : 'location_on'}</span></div>
        <div class="kpi-l">Sin coordenadas</div><div class="kpi-v">${sinCoords}</div></div>
    </div>

    ${rutaVistaOrigen(origen)}

    ${lista.length === 0 ? `
      <div class="card"><div class="empty">
        <span class="ms" style="font-size:48px">local_shipping</span>
        <p>Hoy no hay clientes con pedido activo.<br>Cuando se registre un pedido en <b>Clientes</b>, aparecerá aquí automáticamente.</p>
      </div></div>` : `
      <div class="flex gap-sm mb-md" style="flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="rutaSeleccionarTodos(true)"><span class="ms">check_box</span>Seleccionar todos</button>
        <button class="btn btn-ghost" onclick="rutaSeleccionarTodos(false)"><span class="ms">check_box_outline_blank</span>Deseleccionar todos</button>
      </div>
      <div class="card mb-md" id="ruta-lista">
        ${lista.map((x, i) => rutaFilaHTML(x, i, sel.has(x.cliente.id))).join('')}
      </div>`}

    ${huerfanos ? `<div class="muted mb-md" style="font-size:12px">Hay ${huerfanos} pedido(s) de hoy de clientes que ya no existen: no se pueden incluir en la ruta.</div>` : ''}

    ${lista.length ? `
      <div class="card ruta-accion">
        <div class="card-b flex fb" style="flex-wrap:wrap;gap:10px">
          <div>
            <div class="bold">Clientes seleccionados: <span id="ruta-cont-sel">${sel.size}</span></div>
            <div class="muted" style="font-size:11.5px">La ruta sigue el orden de esta lista.</div>
          </div>
          <button class="btn btn-primary" style="flex:1 1 240px;padding:12px 16px" onclick="rutaAbrirGoogleMaps()">
            <span class="ms">map</span>Abrir ruta en Google Maps
          </button>
        </div>
      </div>` : ''}`;
}

function rutaFilaHTML(x, i, marcado) {
  const c = x.cliente;
  const color = c.color || 'var(--primary)';
  const estado = x.coords
    ? `<span class="loc-badge"><span class="ms" style="font-size:14px">location_on</span>Con coordenadas</span>`
    : `<span class="badge badge-warn">⚠️ Sin coordenadas</span>
       <button class="btn btn-ghost btn-sm" style="margin-left:6px" onclick="event.preventDefault();event.stopPropagation();rutaAsignarUbicacion('${c.id}')">
         <span class="ms">add_location</span>Asignar ubicación</button>`;
  return `
    <label class="flex" data-rid="${c.id}" style="gap:12px;align-items:center;padding:12px var(--s-md);cursor:pointer;
      ${i ? 'border-top:1px solid var(--outline-variant);' : ''}border-left:5px solid ${color}">
      <input type="checkbox" ${marcado ? 'checked' : ''} onchange="rutaMarcar('${c.id}',this.checked)"
        style="width:22px;height:22px;flex:0 0 auto;accent-color:var(--primary)"/>
      <span class="muted" style="font-family:var(--font-mono);font-size:12px;min-width:22px">${i + 1}.</span>
      <div style="flex:1;min-width:0">
        <div class="bold" style="color:${color};overflow:hidden;text-overflow:ellipsis">${rutaEsc(c.nombre)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px">
          ${c.tipo ? `<span>Zona: ${rutaEsc(c.tipo)}</span>` : ''}
          ${c.direccion ? `<span>${rutaEsc(c.direccion)}</span>` : ''}
          ${estado}
        </div>
      </div>
      <span class="num bold" style="white-space:nowrap">${money(x.total)}</span>
    </label>`;
}

function rutaVistaOrigen(origen) {
  return `
    <div class="card mb-md">
      <div class="card-b flex fb" style="flex-wrap:wrap;gap:10px">
        <div style="min-width:0;flex:1 1 260px">
          <div class="flex gap-sm" style="align-items:center">
            <span class="ms" style="color:var(--primary)">storefront</span>
            <span class="bold">Punto de salida</span>
            ${origen ? '<span class="badge badge-success">Configurado</span>' : '<span class="badge badge-muted">Sin configurar</span>'}
          </div>
          <div class="muted" style="font-size:12px;margin-top:4px;line-height:1.5">${origen
            ? `La ruta arranca en Lat ${origen.lat.toFixed(6)}, Lng ${origen.lng.toFixed(6)}.`
            : 'Sin punto de salida, Google Maps arranca la ruta desde la ubicación actual del celular.'}</div>
        </div>
        <button class="btn btn-ghost" onclick="rutaOrigenModal()"><span class="ms">edit_location</span>${origen ? 'Cambiar' : 'Configurar'}</button>
      </div>
    </div>`;
}

function rutaEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ═══════════════════════════ ACCIONES ═══════════════════════════ */

/** Actualiza contadores sin repintar la lista (no se pierde el scroll). */
function _rutaContadores(n) {
  const a = document.getElementById('ruta-kpi-sel'); if (a) a.textContent = n;
  const b = document.getElementById('ruta-cont-sel'); if (b) b.textContent = n;
}

function rutaMarcar(id, marcado) {
  const sel = rutaSeleccion();
  if (marcado) sel.add(id); else sel.delete(id);
  rutaGuardarSeleccion(sel);
  _rutaContadores(sel.size);
  // Soltar el foco del checkbox: mientras un input tiene foco el ERP no repinta
  // con los cambios que llegan en vivo.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function rutaSeleccionarTodos(marcar) {
  const { lista } = rutaClientesDelDia();
  const sel = marcar ? new Set(lista.map(x => x.cliente.id)) : new Set();
  rutaGuardarSeleccion(sel);
  document.querySelectorAll('#ruta-lista input[type="checkbox"]').forEach(cb => { cb.checked = marcar; });
  _rutaContadores(sel.size);
}

/**
 * Abre la ficha del cliente (la misma de la pestaña Clientes) para ponerle
 * ubicación. Solo se cambia a dónde vuelve al guardar: a esta vista.
 */
function rutaAsignarUbicacion(id) {
  editarClienteModal(id);
  const btn = document.querySelector('#modalRoot .modal-f button[onclick^="guardarCliente"]');
  if (btn) btn.onclick = async () => { await guardarCliente(id); go('ruta'); };
}

/* --- Punto de salida --- */

function rutaOrigenModal() {
  const o = rutaOrigen();
  modal('Punto de salida', `
    <div class="muted mb-md" style="font-size:13px;line-height:1.5">
      Ubicación de la panadería o del punto de despacho. Es el origen de todas las rutas.
      Si lo dejas vacío, Google Maps usa la ubicación actual del celular.
    </div>
    <div class="gf">
      <div class="field"><label>Latitud</label><input id="ruta-o-lat" type="text" inputmode="decimal" value="${o ? o.lat : ''}" placeholder="Ej: 2.938000"/></div>
      <div class="field"><label>Longitud</label><input id="ruta-o-lng" type="text" inputmode="decimal" value="${o ? o.lng : ''}" placeholder="Ej: -75.289000"/></div>
    </div>
    <button class="btn btn-ghost" style="width:100%" onclick="rutaOrigenDesdeGPS()"><span class="ms">my_location</span>Usar mi ubicación actual</button>
    <div class="muted mt-md" style="font-size:11.5px">Consejo: toma la ubicación estando dentro de la panadería.</div>
  `, `${o ? '<button class="btn btn-danger" onclick="rutaGuardarOrigen(true)">Quitar</button>' : ''}
      <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="rutaGuardarOrigen(false)">Guardar</button>`);
}

function rutaOrigenDesdeGPS() {
  if (!navigator.geolocation) { toast('Geolocalización no disponible en este dispositivo', 'error'); return; }
  toast('Obteniendo ubicación...', '');
  navigator.geolocation.getCurrentPosition(pos => {
    const a = document.getElementById('ruta-o-lat'), b = document.getElementById('ruta-o-lng');
    if (a) a.value = pos.coords.latitude.toFixed(6);
    if (b) b.value = pos.coords.longitude.toFixed(6);
    toast('Ubicación tomada. Revisa y guarda.', 'success');
  }, () => toast('No se pudo obtener la ubicación. Revisa los permisos del navegador.', 'error'),
  { enableHighAccuracy: true, timeout: 15000 });
}

async function rutaGuardarOrigen(quitar) {
  let patch;
  if (quitar) {
    patch = { rutaOrigenLat: null, rutaOrigenLng: null };
  } else {
    const lat = $('#ruta-o-lat').value.trim().replace(',', '.');
    const lng = $('#ruta-o-lng').value.trim().replace(',', '.');
    if (!rutaCoords({ lat, lng })) { toast('Coordenadas inválidas. Ej: Latitud 2.938000, Longitud -75.289000', 'error'); return; }
    patch = { rutaOrigenLat: Number(lat), rutaOrigenLng: Number(lng) };
  }
  try {
    await appwriteService.guardarFacturaConfig(patch);
    saveDB(); closeModal(); renderRuta();
    toast(quitar ? 'Punto de salida quitado' : 'Punto de salida guardado', 'success');
  } catch (e) { /* el servicio ya mostró el motivo */ }
}

/* --- Google Maps --- */

const _rutaPunto = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Enlace de Google Maps (Maps URLs, api=1) para un tramo de paradas. */
function rutaUrlGoogleMaps(origen, paradas) {
  const destino = paradas[paradas.length - 1];
  const intermedias = paradas.slice(0, -1);
  let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
  if (origen) url += '&origin=' + encodeURIComponent(_rutaPunto(origen));
  url += '&destination=' + encodeURIComponent(_rutaPunto(destino));
  if (intermedias.length) url += '&waypoints=' + encodeURIComponent(intermedias.map(_rutaPunto).join('|'));
  return url;
}

/** Parte las paradas en tramos de máximo RUTA_MAX_PARADAS; cada tramo sale del final del anterior. */
function rutaTramos(origen, paradas) {
  const tramos = [];
  let desde = origen;
  for (let i = 0; i < paradas.length; i += RUTA_MAX_PARADAS) {
    const grupo = paradas.slice(i, i + RUTA_MAX_PARADAS);
    tramos.push({ desde, grupo, inicio: i + 1, fin: i + grupo.length, url: rutaUrlGoogleMaps(desde, grupo.map(x => x.coords)) });
    desde = grupo[grupo.length - 1].coords;
  }
  return tramos;
}

function rutaAbrirGoogleMaps(ignorarSinCoords) {
  const { lista } = rutaClientesDelDia();
  const sel = rutaSeleccion();
  // Orden = el de la lista (que es el de Clientes), no el orden en que se marcaron.
  const elegidos = lista.filter(x => sel.has(x.cliente.id));
  if (!elegidos.length) { toast('Selecciona al menos un cliente para crear la ruta.', 'error'); return; }

  const sinCoords = elegidos.filter(x => !x.coords);
  const paradas = elegidos.filter(x => x.coords);

  if (sinCoords.length && !ignorarSinCoords) {
    modal('Clientes sin coordenadas', `
      <p>Estos clientes no tienen coordenadas registradas:</p>
      <ul style="margin:8px 0 0;padding-left:20px;line-height:1.8">
        ${sinCoords.map(x => `<li><b>${rutaEsc(x.cliente.nombre)}</b></li>`).join('')}
      </ul>
      <p class="muted mt-md" style="font-size:12.5px">${paradas.length
        ? `No se enviarán a Google Maps. La ruta se puede abrir con los otros ${paradas.length} cliente(s).`
        : 'Ningún cliente seleccionado tiene coordenadas: asígnales ubicación primero.'}</p>`,
      `<button class="btn btn-ghost" onclick="closeModal()">Volver</button>
       ${paradas.length ? `<button class="btn btn-primary" onclick="closeModal();rutaAbrirGoogleMaps(true)"><span class="ms">map</span>Abrir ruta sin ellos</button>` : ''}`);
    return;
  }
  if (!paradas.length) { toast('Ningún cliente seleccionado tiene coordenadas.', 'error'); return; }

  const tramos = rutaTramos(rutaOrigen(), paradas);
  if (tramos.length === 1) {
    window.open(tramos[0].url, '_blank', 'noopener');
    toast(`Abriendo Google Maps con ${paradas.length} parada(s)...`, 'default');
    return;
  }

  // Más de 10 paradas: un botón por tramo. Se abren de a uno (cada clic es un
  // gesto del usuario) porque el navegador bloquea abrir varias pestañas juntas.
  modal('Ruta dividida en tramos', `
    <p style="line-height:1.5">Google Maps admite máximo <b>${RUTA_MAX_PARADAS} paradas por ruta</b>.
      Elegiste ${paradas.length}, así que la ruta quedó en <b>${tramos.length} tramos</b>. Abre el siguiente cuando termines el anterior:
      cada tramo arranca en la última parada del anterior.</p>
    <div class="flex mt-md" style="flex-direction:column;gap:8px">
      ${tramos.map((t, k) => `
        <a class="btn ${k === 0 ? 'btn-primary' : 'btn-ghost'}" href="${t.url}" target="_blank" rel="noopener" style="justify-content:flex-start;white-space:normal;text-align:left">
          <span class="ms">map</span>
          <span>Tramo ${k + 1}: paradas ${t.inicio}–${t.fin}<br>
            <span style="font-size:11.5px;font-weight:500;opacity:.85">${t.grupo.map(x => rutaEsc(x.cliente.nombre)).join(' → ')}</span></span>
        </a>`).join('')}
    </div>`,
    `<button class="btn btn-ghost" onclick="closeModal()">Cerrar</button>`);
}

/* ═══════════════════════════ REGISTRO EN EL ERP ═══════════════════════════ */
ROUTES.ruta = renderRuta;
