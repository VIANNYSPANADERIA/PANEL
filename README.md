# 🥐 VIANNYS PANADERIA — ERP

Sistema ERP profesional para panadería conectado 100% a Supabase con realtime.

## ✨ Features
- 👥 **Clientes** — derivados automáticamente de pedidos, mint cards con saldo
- 🧾 **Pedidos** — captura por cantidad o por dinero (factor) con conversión bidireccional
- 🥐 **Productos** — catálogo local con imágenes propias y precios editables inline
- 🖨️ **Tickets** — formato POS impresión 80mm con bendaje
- 💼 **Cartera** — semáforo de riesgo, deudas y pagos cruzados
- 💵 **Recaudo** — control diario con desglose por método de pago
- 👷 **Nómina** — quincenal y semanal con asistencia + adelantos editables
- 💹 **Flujo de Caja** — cuentas bancarias con saldos en vivo + transferencias
- 📒 **Contabilidad** — Resumen, Historial, Categorías, Dashboards (Chart.js)
- 🔄 **Realtime** — Supabase websocket en todas las tablas
- 🌗 **Tema claro/oscuro** alternable

## 🚀 Cómo correr local

1. Clona el repo
2. Edita `js/config.js` con tu URL y ANON KEY de Supabase
3. Sirve los archivos estáticos:

```bash
# Opción A: Python
python3 -m http.server 8080

# Opción B: Node
npx serve .

# Opción C: cualquier servidor web (nginx, apache, etc.)
```

4. Abre `http://localhost:8080/panel.html`

## 📊 Schema Supabase

Tu Supabase debe tener estas tablas (las descubre el sistema automáticamente):

**Relacionales:**
- `pedidos` (id, fecha, cliente, barrio, pedido, total, deuda, editado, bendaje, tipo, comentario, productos jsonb, metodo_pago)
- `gastos` (id, fecha, categoria, valor, descripcion)

**Tipo "doc único" con `datos` jsonb:**
- `cartera_pagos` — array `[{cliente,fecha,monto,banco,metodo,nota,cuentaIdx}]`
- `cuentas_bancarias` — array `[{id,nombre,tipo,color,saldo}]`
- `conta_categorias_v2` — `{costos:[…], gastos:[…], ingresos:[…]}`
- `conta_movimientos_v2` — array `[{id,tipo,fecha,monto,categoria,descripcion}]`
- `nomina_config` — `{empleados:[{id,nombre,tipo,color,salarioQuincena,salarioDia,adelantos:[],asistencia:[]}]}`

## 🌐 Deploy

Cualquier hosting estático funciona:
- **Vercel** — drag & drop la carpeta o conecta el repo
- **Netlify** — `netlify deploy --dir=.`
- **GitHub Pages** — push y activa Pages en Settings
- **Cloudflare Pages** — conecta el repo

## 📁 Estructura

```
.
├── panel.html           # ERP principal
├── contabilidad.html    # Sistema contable
├── index.html           # Redirige a /panel.html
├── css/
│   └── app.css          # Tema claro/oscuro
└── js/
    ├── config.js        # Credenciales Supabase ← EDITAR
    ├── supabase-client.js
    ├── utils.js
    ├── panel.js
    ├── contabilidad.js
    └── modules/
        ├── clientes.js
        ├── pedidos.js
        ├── productos.js
        ├── tickets.js
        ├── cartera.js
        ├── recaudo.js
        ├── nomina.js
        ├── flujo_caja.js
        ├── estadisticas.js
        └── sync.js
```

## 🛠 Tecnologías

- **HTML5/CSS3/JS Vanilla** (sin framework)
- **Supabase** (PostgreSQL + Realtime + REST)
- **Chart.js 4** (gráficos)
- **Plus Jakarta Sans** (tipografía)

## 📜 Licencia

Privado — uso comercial autorizado solo por el dueño.

---
Made with 🥐 for Vianny's Panadería
