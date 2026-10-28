# Costos por arroba (modelo `arroba_v2`) · Instalación

## 1. Archivos modificados

| Archivo | Cambio |
|---|---|
| `pocketbaseConfig.js` | Nueva colección lógica `categoriasMasa → categorias_masa`. |
| `pocketbaseService.js` | CRUD de categorías de masa, `guardarReceta`/`guardarProduccion` con doble modelo, guardado idempotente con reversión, insumos con contenido por paquete, migración `migrarCostosV2()`, carga/caché/resync/realtime de la nueva colección. |
| `costos.js` | Motor de cálculo por arroba, pestañas Masas y recetas y Producción nuevas, `coDia()` unificado, punto de equilibrio con mezcla, vendajes corregidos. |
| `index.html` | `loadDB()` restaura `DB.costos` (y `DB.calendario`) con valores por defecto; `DB.costos.categorias`. |
| `pb_migrations/1761580800_crear_categorias_masa.js` | Crea la colección en PocketBase. |

No se crean colecciones para producción ni insumos: los registros nuevos usan las mismas (`produccion`, `insumos`, `recetas`) y se distinguen por `modelo`.

## 2. Crear la colección en PocketBase (una sola vez)

**Opción A — migración (recomendada, PocketBase 0.23 o superior):**

1. Copia `pb_migrations/1761580800_crear_categorias_masa.js` a la carpeta `pb_migrations/` junto al ejecutable de PocketBase en el servidor.
2. Reinicia PocketBase. Al arrancar aplica la migración. Es segura de repetir: si la colección existe, no hace nada.
3. Copia las reglas de `produccion`. Si esa colección no existe, usa `@request.auth.id != ''`.

**Opción B — panel de administración (`https://viannyspanaderia.duckdns.org/_/`):**

1. *New collection* → tipo **Base** → nombre `categorias_masa`.
2. Campo: **JSON**, nombre `data`, no obligatorio, tamaño máximo 2 MB.
3. *API Rules*: copia las 5 reglas (List, View, Create, Update, Delete) que tiene hoy `produccion`.
4. Guardar.

Las credenciales de administrador se usan solo en el panel o en el servidor. El navegador sigue usando el usuario normal del ERP.

**Opcional:** revisa que el campo `data` de `produccion` admita al menos 1 MB. Cada registro nuevo guarda una copia de la receta y los precios usados (unos pocos KB).

## 3. Publicar el panel

1. Sube `index.html`, `costos.js`, `pocketbaseService.js` y `pocketbaseConfig.js` al hosting de siempre.
2. Recarga con Ctrl+F5 en cada dispositivo.
3. Si la colección no existe todavía, el panel avisa "1 tabla(s) no cargaron" y "Sync en vivo sin: categorias_masa". El resto del ERP sigue funcionando.

## 4. Primer uso

1. **Insumos:** revisa los que estén comprados por paquete, caja o bulto. Indica cuántas unidades trae cada uno (200 bolsas por paquete). Mientras no lo indiques, aparecen como "Contenido sin definir" y su costeo queda incompleto.
2. **Masas y recetas → Nueva categoría de masa:**
   - escribe la receta para 1 arroba, para media arroba o para otra cantidad;
   - asocia los tipos de pan con sus bolitas por pan y, si quieres, panes por lata;
   - agrega empaques por pan, por grupo de N panes, por arroba o por registro;
   - opcional: define un reparto predeterminado.
3. **Masas y recetas → Recetas antiguas por lata → "Marcar como modelo antiguo".** Esto marca las recetas y producciones viejas como `lata_v1`. No borra ni convierte nada y se puede repetir.
4. **Producción → Registrar producción:**
   1. Elige la categoría y escribe la cantidad en libras o arrobas.
   2. Opcional: reparte las bolitas entre los panes.
   3. Cuando tengas el conteo real, usa ✓ **Confirmar conteo**.

## 5. Modelo de datos

```text
categorias_masa.data = {
  id, modelo:'arroba_v2', nombre, activo, observaciones, creado, actualizado,
  arrobasBase,                                  // 1 | 0.5 | otra
  ingredientes: [{insumoId, cantidad}],         // unidad base, PARA arrobasBase
  parametros: {librasPorArroba:25, kgRefPorArroba:12, pepasPorArroba:4, bolitasPorPepa:36},
  adicionales: [{insumoId, cantidad, base:'arroba'|'lote'}],          // una vez por lote
  productos: [{lineaId, productoId, bolitasPorPan, panesPorLata|null,
               adicionales:[{insumoId, cantidad, base:'pan'|'grupo'|'arroba'|'lote', grupo}]}],
  repartoPredeterminado: {lineaId: % de bolitas}
}

produccion.data (nuevo) = {
  id, modelo:'arroba_v2', version:2, fecha, categoriaId, categoriaNombre,
  cantidad, unidad:'lb'|'arroba', estado:'pendiente'|'planificado'|'confirmado', confirmado,
  reparto: [{lineaId, productoId, bolitasAsignadas, panesConfirmados}],
  snapshot: {parametros, arrobasBase, ingredientes+precios, adicionales+precios, lineas+precios de venta},
  resultado: {arrobas, libras, pesoRefKg, pepas, bolitas, costoMasaLote, costoPorBolita,
              potenciales[], reparto[] (panes, remanentes, latas, adicionales, costos),
              bolitasSinAsignar, costoAdicionales, costoTotalLote, completo, motivos[]},
  creado, actualizado
}

produccion.data (antiguo) = {id, modelo:'lata_v1', fecha, productoId, latas, panesPorLata, pesoPorPan, costoLata}
insumos.data += {contenidoPorUnidad, contenidoPendiente}
```

Un producto puede estar en varias categorías. Cada asociación se identifica por `categoriaId` + `lineaId`, nunca solo por `productoId`.
