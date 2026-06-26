# ERP Panadería

ERP SaaS para panadería. Frontend vanilla HTML5/CSS3/JS ES2025 · Backend Google Apps Script · Base de datos Google Sheets.

## Inicio rápido
1. Lee **[`docs/GOOGLE_SHEETS_PASO_A_PASO.md`](docs/GOOGLE_SHEETS_PASO_A_PASO.md)** — guía de 0 a producción (~25 min).
2. Pega tu `API_URL` y `SPREADSHEET_ID` en `js/config.js`.
3. Sirve esta carpeta por HTTP (`npx serve .`) y abre el login (`admin`/`admin`).

## Estructura
Ver [`docs/README.md`](docs/README.md) y [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Documentación
| Doc | Contenido |
|---|---|
| [GOOGLE_SHEETS_PASO_A_PASO.md](docs/GOOGLE_SHEETS_PASO_A_PASO.md) | Guía paso a paso Google Sheets + Apps Script desde 0 |
| [BASE_DE_DATOS.md](docs/BASE_DE_DATOS.md) | Schema de las 24 hojas |
| [API.md](docs/API.md) | Endpoints REST |
| [ARQUITECTURA.md](docs/ARQUITECTURA.md) | Capas y flujos |
| [MIGRACION.md](docs/MIGRACION.md) | Migración Supabase → Sheets |
| [DESPLIEGUE.md](docs/DESPLIEGUE.md) | Despliegue + triggers |

## Módulos
Dashboard, Clientes, Pedidos (centro + constructor), Producción, Inventario, Compras, Recaudos, Caja, Cuentas, Gastos, Reportes, Logística, Configuración, Auditoría.

## Notas
- Reemplaza el anon JWT de Supabase: **no se usa**. La identidad del backend proviene de `Session.getActiveUser().getEmail()` + token firmado.
- No almacenes nada en LocalStorage como fuente de verdad; el `CacheManager` es solo cache de UI (se reinicia al refrescar).
- Cambia la contraseña de `admin` nada más entrar.