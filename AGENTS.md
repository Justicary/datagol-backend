# Manual de Ingeniería, Estándares de Código y Control de Calidad — AGENTS.md (Datagol API 2026)

Este documento define las directrices obligatorias, estándares de arquitectura, políticas de calidad de código, pruebas unitarias y métricas de pruebas de mutación para el desarrollo en Antigravity IDE del backend (`datagol-backend`).

Es documento hermano de `AGENTS.md` de `datagol-frontend`. Las secciones de principios de código, TypeScript, testing y QA workflow son deliberadamente simétricas; las secciones de latencia, webhooks, multi-tenancy, metering y secretos son exclusivas del backend.

---

# Project goal

API de orquestación para una plataforma de Agentes de IA de Voz y Automatización Omnicanal bajo modelo Done-For-You (DFY): cada PyME cliente opera su propia infraestructura de proveedores (ElevenLabs, Telnyx, Meta/WhatsApp) y Datagol provee el plano de control, la lógica de negocio y las herramientas (*tools*) que el agente invoca durante la conversación.

**Restricción rectora del proyecto:** este backend **no toca audio**. ElevenLabs recibe la llamada vía SIP desde Telnyx y gestiona íntegramente el media path. La API es un servicio HTTP de *tool calls* y *webhooks*. Cualquier propuesta de implementar streaming de audio, WebSockets de media o transcodificación debe rechazarse: es responsabilidad del proveedor.

---

# Technology stack

- **Node.js 24 LTS** con **TypeScript ^7** y `@types/node` (^26) — ejecutado mediante `tsx` (^4.23.1) con tipado estricto (`strict: true`).
- **Fastify ^5** (`fastify` ^5.10.0) — servidor HTTP con plugins oficiales:
  - `@fastify/multipart` (^10.1.0) para carga segura de archivos (límite 10 MB).
  - `@fastify/websocket` (^11.3.0) para conexiones en tiempo real.
- **Supabase** (`@supabase/supabase-js` ^2.110.8) — Postgres, Auth, almacenamiento y búsquedas vectoriales RAG (`match_documents`).
- **Integraciones de Voz y Telecomunicaciones**:
  - **ElevenLabs ConvAI** (API REST, Signed URLs WebSocket y SIP Trunking).
  - **Vapi AI** (`@vapi-ai/server-sdk` ^1.2.0) como proveedor de voz alternativo.
  - **Twilio** (`twilio` ^6.0.2) para integración de telefonía saliente y mensajes.
  - **Resend** (`resend` ^6.18.0) para notificaciones y envío de minutas ejecutivas por email.
- **Inteligencia Artificial y Embeddings**:
  - `openai` (^6.49.0) y Vercel AI SDK (`ai` ^7.0.37) para embeddings (`text-embedding-3-small`) y orquestación de LLMs.
- **Procesamiento de Archivos e Importaciones**:
  - `exceljs` (^4.4.0) y `@types/exceljs` (^1.3.2) para ingesta de archivos `.xlsx` y `.csv` en memoria.
- **Colas y Caché Asíncrona**:
  - `pg-boss` (^12.27.0) sobre el mismo Postgres para todo trabajo diferido (ver §8). Nada de BullMQ/Redis: un solo motor de colas, sin infraestructura adicional que mantener.
- **Configuración y Entorno**:
  - `dotenv` (^17.4.2) para carga de variables de entorno.
- **pnpm ^10.5.2** — package manager obligatorio (no usar `npm` ni `yarn`).
- **Docker** — contenedor agnóstico listo para despliegue en cualquier nube.

## Reglas arbitradas por el stack

- Queda prohibido introducir un ORM pesado. Se usa el cliente de Supabase o SQL parametrizado; las migraciones viven versionadas en `db/migrations/`.
- Queda prohibido `console.log`. Todo log pasa por el logger de Fastify (`request.log` / `fastify.log`) en formato estructurado.
- Ninguna dependencia nueva se agrega sin justificar por qué no se resuelve con la librería estándar o con lo ya instalado.
- Toda ruta declara su esquema Zod de `body`, `params`, `querystring` y `response`. Sin esquema no se hace merge.

---

## Coding Guidelines & Architecture

### 🎯 1. Principios Guía de Desarrollo para Agentes de IA

* **Código Limpio y Modular:** Escribe código DRY. Extrae lógica de negocio en servicios puros y testeables, separados de los handlers de Fastify.
* **Latencia Primero:** Cada milisegundo en un *tool call* es silencio audible en la llamada. Optimiza el camino crítico antes que la elegancia.
* **Nomenclatura:** `camelCase` para variables, funciones y servicios; `PascalCase` para clases y tipos. Archivos en `kebab-case.ts`.
* **Tipado Estricto Obligatorio:** Cero uso de `any`. Todo DTO, payload de webhook y respuesta de tool debe ser explícito y validado.
* **Aislamiento Funcional (Single Responsibility):** Cada ruta hace una sola cosa. Los handlers orquestan; no contienen lógica de negocio.
* **Respuestas en Español Técnico:** Comentarios de código, mensajes de log explicativos y documentación de funciones en español claro y conciso.
* **Errores Explícitos:** Nunca tragar excepciones. Todo error se registra con `tenant_id`, `conversation_id` y `request_id`.

### 🏗️ 2. Estructura de Proyecto Estándar

```
datagol-api/
├── src/
│   ├── server.ts              # Bootstrap de Fastify, registro de plugins
│   ├── plugins/               # Plugins Fastify (auth, supabase, tenant-context, metering)
│   ├── routes/
│   │   ├── tools/             # Tool calls invocados por el agente EN VIVO (presupuesto <300ms)
│   │   │   ├── availability.ts    # Consulta de disponibilidad de agenda
│   │   │   ├── booking.ts         # Creación/reagendado de cita
│   │   │   └── lookup.ts          # Identificación de contacto por teléfono (continuidad cross-canal)
│   │   ├── webhooks/          # Ingesta asíncrona (post-call, estado de mensaje)
│   │   │   ├── elevenlabs.ts
│   │   │   └── meta.ts
│   │   └── admin/             # API del dashboard (autenticada por sesión Supabase)
│   ├── services/              # Lógica de negocio pura, sin dependencias de Fastify
│   ├── jobs/                  # Handlers de pg-boss (outbound, recordatorios, reintentos)
│   ├── schemas/               # Esquemas Zod compartidos
│   ├── lib/                   # Clientes de servicios (supabase, elevenlabs, telnyx, meta)
│   └── types/                 # Tipos compartidos
├── db/                        # Esquema de la Base de Datos
│   └── migrations/            # Migraciones SQL versionadas
└── __tests__/                 # Pruebas unitarias e integración (Vitest)
```

**Regla de dependencia:** `routes/` → `services/` → `lib/`. Nunca al revés. Un servicio no importa nada de Fastify.

### ⏱️ 3. Contratos de Latencia (Camino Crítico de Voz)

Las rutas bajo `routes/tools/` se ejecutan **mientras el interlocutor humano espera en silencio**. Son el único lugar del sistema con presupuesto de latencia contractual.

| Métrica | Presupuesto |
|---|---|
| p95 de respuesta en `routes/tools/**` | **< 300 ms** |
| p99 de respuesta en `routes/tools/**` | < 600 ms |
| Consulta a base de conocimiento (si aplica) | < 100 ms |
| Instancias mínimas en producción | **≥ 1** (cold start = llamada perdida) |

Reglas derivadas, de cumplimiento obligatorio:

* **Prohibido llamar a una API de terceros de forma síncrona dentro de un tool call** salvo que sea el propósito mismo del tool. Si hace falta notificar, confirmar o sincronizar, se encola en pg-boss y se responde de inmediato.
* **El RAG del camino de llamada vive en la knowledge base nativa de ElevenLabs**, no en Supabase. Un salto de red extra por turno de conversación es latencia regalada.
* Si un índice vectorial se usa en Postgres para cualquier otro propósito, debe ser **HNSW**, nunca IVFFlat.
* Todo tool debe tener *timeout* propio y una respuesta degradada útil. Un tool que falla debe devolver algo que el agente pueda verbalizar («no puedo consultar la agenda en este momento, ¿te llamo de vuelta?»), nunca un 500 mudo.
* Toda ruta de tool registra su duración. Una regresión de p95 es un bug de severidad alta, no una optimización pendiente.

### 🛡️ 4. Seguridad de Webhooks e Idempotencia

ElevenLabs, Meta y Telnyx **reintentan**. Sin protección, el sistema agenda citas duplicadas — el fallo más caro en términos de confianza del cliente.

* **Verificación de firma obligatoria** en todo webhook entrante, antes de parsear el cuerpo. Un webhook sin firma válida se rechaza con 401 y se registra.
* **Clave de idempotencia obligatoria** en toda operación con efecto de escritura originada en un webhook o en un tool call. La clave se persiste con restricción `UNIQUE`; un reintento devuelve el resultado original, no ejecuta de nuevo.
* Los handlers de webhook responden **2xx rápido** y delegan el trabajo a pg-boss. Un webhook no es lugar para lógica lenta.
* El cuerpo crudo del webhook se conserva para poder reprocesar y auditar.

### 🏢 5. Multi-Tenancy y Aislamiento

Modelo híbrido: un proyecto Supabase como **plano de control** compartido, con proyecto dedicado solo para clientes que exijan aislamiento regulatorio real.

* **Toda tabla de negocio lleva `tenant_id`** y tiene RLS habilitada. Sin excepciones.
* El `tenant_id` se resuelve en un plugin de Fastify (`tenant-context`) y se inyecta en `request`. **Prohibido leer `tenant_id` del body de la petición** en rutas administrativas.
* Los tools llamados por el agente identifican al tenant por el agente/número que originó la llamada, nunca por un parámetro que el LLM pueda alucinar o que un tercero pueda falsificar.
* Ninguna consulta cruza tenants. Cualquier query sin filtro de tenant es un bug de seguridad.

### 📊 6. Metering y Atribución de Costos

Sin esto no se puede facturar ni detectar al cliente que quema margen. **Se implementa desde la v1, no después.**

* Toda unidad consumible se registra por tenant al momento de consumirse: minutos de agente, tokens de LLM, mensajes de WhatsApp (con su categoría Meta), minutos de telefonía por dirección y tipo de destino (fijo/móvil), grabaciones.
* La tabla de metering es **append-only**. Las correcciones se hacen con asientos compensatorios, nunca con `UPDATE`.
* Cada registro guarda la tarifa aplicada al momento del consumo. Las tarifas de los proveedores cambian trimestralmente; un cálculo retroactivo con tarifa actual produce cifras falsas.
* Debe existir un endpoint de conciliación que compare el metering interno contra la factura real del proveedor.

### 🔐 7. Gestión de Secretos por Cliente

Cada PyME aporta sus propias credenciales de ElevenLabs, Telnyx y Meta.

* **Prohibido almacenar credenciales de cliente en columnas de Postgres en claro.** Se usa un gestor de secretos externo o cifrado a nivel de columna.
* Las credenciales nunca aparecen en logs, mensajes de error ni respuestas de API. El logger debe tener redacción configurada para los campos sensibles.
* La rotación de credenciales debe ser posible sin desplegar código.

### ⚙️ 8. Colas y Trabajos Asíncronos

* Todo trabajo diferido pasa por **pg-boss**. Nada de `setTimeout`, nada de procesos de fondo improvisados.
* Todo job es **idempotente y reintentable**. Se asume que se ejecutará más de una vez.
* Los jobs de outbound respetan límites de tasa por tenant y los umbrales de CPS del proveedor telefónico.
* Las tareas recurrentes usan `pg_cron` o el scheduler de pg-boss, no un cron externo al contenedor.
* Todo job registra su resultado con `tenant_id`. Un job que falla en silencio es un cliente perdido.

### 🧪 9. Estrategia de Testing y Cobertura (Unit & Integration)

* El proyecto utiliza **Vitest** como runner de pruebas ultrarrápido con soporte nativo para TypeScript y ESM.
* Toda prueba de rechazo debe tener su contraparte de éxito. Verificar que una operación falla cuando debe fallar no prueba nada si la operación falla siempre. Ninguna prueba de validación, permiso o guarda se acepta sin la prueba complementaria que ejercita el camino completo con datos reales.
* Requisitos Mínimos de Cobertura (Code Coverage Targets):
    * Statements (Declaraciones): ≥ 85%
    * Branches (Ramas de decisión): ≥ 80%
    * Functions (Funciones): ≥ 85%
    * Lines (Líneas de código): ≥ 85%
* Comando de Ejecución:
    * `pnpm test`
    * `pnpm test:coverage`
* **Ejemplos de Pruebas Obligatorias:**
    * **Aislamiento multi-tenant:** una petición con credenciales del tenant A no puede leer ni escribir datos del tenant B. Esta prueba es innegociable.
    * **Idempotencia de webhooks:** el mismo payload entregado dos veces produce exactamente un efecto.
    * **Verificación de firma:** un webhook con firma inválida, ausente o caducada se rechaza.
    * **Tools con dependencia caída:** cuando el proveedor de calendario no responde, el tool devuelve una respuesta degradada verbalizable dentro del presupuesto de latencia.
    * **Metering:** una llamada de 3 minutos 20 segundos con 4 mensajes de WhatsApp produce los asientos correctos con las tarifas correctas.
    * **Validación E.164:** los números de teléfono se normalizan y validan antes de cualquier operación de telefonía.

### 🧬 10. Pruebas de Mutación con Stryker Mutator

**Stryker** es una herramienta de pruebas de mutación (mutation testing) utilizada por los desarrolladores para evaluar la calidad de sus pruebas unitarias automatizadas. Funciona mediante la inserción temporal y automática de pequeños errores (llamados "mutantes") en el código fuente para comprobar si las pruebas unitarias detectan los fallos o no los perciben. Ayuda a efectividad de las pruebas y mejora de la calidad del código.

Las pruebas unitarias tradicionales pueden dar una falsa sensación de seguridad al medir solo las líneas ejecutadas. Para garantizar que los tests realmente validen la lógica de negocio, implementamos Pruebas de Mutación con Stryker Mutator (`@stryker-mutator/core`).

'break' permanece en 'null' hasta que las Fases 3–6 completen cobertura. Al cerrar la Fase 6 se fija en 80. Los archivos de seguridad y aislamiento (secret-service, entitlements, webhook-verification) deben mantener ≥90% desde ahora, verificado manualmente en cada PR mientras break esté desactivado.

Los umbrales de la categoría seguridad y aislamiento se miden contra el mutation score total, no contra el score de código cubierto. Un archivo de esta categoría no puede tener código sin ejercitar: si existe una ruta que ninguna prueba toca, esa es precisamente la ruta que un atacante encuentra. Las demás categorías se miden contra el score de código cubierto.

* Métricas Exigidas (Mutation Score Thresholds):
    * **Seguridad y aislamiento** (tenant context, verificación de firma, idempotencia): **≥ 90%**
    * **Metering y cálculo de costos:** ≥ 90%
    * **Servicios de integración** (ElevenLabs, Telnyx, Meta, Supabase, Cal.com): ≥ 80%
    * **Handlers de rutas y jobs:** ≥ 75%
    * **Promedio Global del Proyecto:** ≥ 80%

Comando: `pnpm stryker run`

### ✅ 11. Procedimientos de Control de Calidad (QA Workflow)

Antes de hacer un `git push` o solicitar un Pull Request hacia `main`, todo desarrollador o agente de Antigravity IDE debe ejecutar la siguiente secuencia:

```bash
# 1. Verificación de Tipos Estrictos
pnpm type-check
# 2. Análisis Estático de Código (Linter)
pnpm lint
# 3. Suite de Pruebas Unitarias
pnpm test
# 4. Verificación de Mutación
pnpm stryker run
# 5. Verificación de que la imagen construye
docker build -t datagol-api:local .
```

### 🔤 12. TypeScript

* **Tipado Estricto:** Prohibido `any`. Usa `unknown` para datos verdaderamente dinámicos y aplica *type narrowing* con Zod.
* **Interfaces vs Types:** Prioriza `interface` para objetos estructurados y contratos de servicio. Usa `type` para uniones, tuplas y primitivos.
* **Payloads externos:** todo dato que cruza la frontera del proceso (webhook, respuesta de proveedor, fila de base de datos) se valida con Zod antes de usarse. Un tipo de TypeScript no valida nada en runtime.

### 🚀 13. Convenciones de Fastify

* **Todo es un plugin.** La funcionalidad transversal (autenticación, contexto de tenant, metering, clientes de servicio) se registra con `fastify-plugin`.
* **Decoradores sobre singletons:** los clientes de servicio se exponen vía `fastify.decorate()`, no como imports globales — así son sustituibles en pruebas.
* **Esquemas de respuesta obligatorios:** además de validar, permiten a Fastify serializar rápido. Es rendimiento gratis en el camino crítico.
* **Manejador de errores centralizado** con `setErrorHandler`. Ningún handler devuelve errores crudos del proveedor al cliente.
* **Graceful shutdown obligatorio:** al recibir `SIGTERM`, dejar de aceptar peticiones, terminar las en vuelo y cerrar los workers de pg-boss antes de salir.

### 👁️ 14. Observabilidad

* **Logging estructurado** con pino. Todo log incluye `request_id`, y cuando aplique `tenant_id` y `conversation_id`.
* **Health checks:** `/health` (liveness, sin dependencias) y `/ready` (readiness, verifica base de datos y cola). El orquestador de contenedores depende de que sean honestos.
* **Métricas mínimas:** latencia por ruta de tool (p50/p95/p99), tasa de error por proveedor, profundidad de cola, jobs fallidos.
* **Observabilidad de conversación:** las excepciones no cuentan la historia completa. Cada llamada persiste transcripción y desenlace (`outcome`) para revisión periódica. Un agente que entendió mal y colgó es un fallo de producto que ningún monitor de errores detecta.

### 🐳 15. Contenedores y Despliegue

* Imagen base `node:24-alpine`. Build multi-etapa; la imagen final no contiene `devDependencies` ni código fuente TypeScript.
* El proceso corre como usuario no-root.
* **Toda la configuración por variables de entorno**, validadas con Zod al arranque. La aplicación debe fallar de inmediato y con mensaje claro si falta una variable, nunca a mitad de una llamada.
* **Cero dependencias de un proveedor de nube específico** en el camino crítico. Migrar de hosting debe ser cambiar un origin, no reescribir código.
* El API de voz y los workers se despliegan co-ubicados con la región del proveedor de voz, no con la región del usuario final.

### 🎛️ 16. Entitlements y Control de Features

El sistema opera bajo un modelo Done-For-You donde cada cliente contrata un plan distinto. Las capacidades habilitadas por organización se resuelven contra las tablas features, plans, plan_features y organization_features, con precedencia estricta: kill switch global → override del superadmin → plan contratado → denegado.

Denegar por defecto es deliberado. Cada feature habilitada tiene consecuencia de costo en la cuenta del cliente.

Dónde se resuelven. Nunca dentro del camino crítico de una llamada. Únicamente en tres momentos, todos fuera del turno de conversación:

Al provisionar o actualizar el agente en el proveedor de voz. Las features determinan qué herramientas se registran y qué canales se conectan. Un tenant sin call_transfer no debe tener esa herramienta expuesta — así el agente no puede prometer algo que el sistema no puede cumplir.
Al procesar webhooks y jobs. Verificar la feature antes de ejecutar el efecto, no antes de encolar.
Al servir rutas de routes/admin/**.

Consulta y caché. Una sola llamada a organization_enabled_features(org_id) por resolución, nunca una consulta por feature. El resultado se cachea en memoria con TTL corto e invalidación explícita cuando el superadmin modifica un entitlement.

La aplicación es del servidor. Ocultar un control en el dashboard no es un mecanismo de seguridad. Toda ruta que dependa de una feature la verifica del lado del servidor mediante el plugin que decora request.features, y rechaza con 403 y un mensaje accionable.

Guarda de credenciales. Antes de habilitar una feature con requires_provider, verificar que existan las credenciales correspondientes en organization_secrets. Habilitar un canal sin las credenciales de su proveedor produce un fallo silencioso que el cliente descubre con un prospecto perdido.

Advertencia de costo. Si has_cost_impact es verdadero, la interfaz debe advertirlo de forma explícita antes de confirmar, citando la tarifa vigente desde provider_rates. El cliente paga su propia infraestructura: activar salientes le cambia la factura.

Concurrencia. plans.max_concurrent_calls se sincroniza con organizations.max_concurrent_calls al cambiar de plan. Ese valor nunca puede exceder el límite del workspace del proveedor de voz: rebasarlo dispara facturación de sobredemanda al doble por minuto.

Bitácora. Todo cambio de entitlement escribe en feature_audit_log dentro de la misma transacción que el cambio. Si el registro falla, el cambio se revierte. La tabla es append-only.

Prohibido. Está prohibido introducir un sistema de flags paralelo — ni variables de entorno por cliente, ni banderas en integration_settings, ni condicionales sobre plan_key dispersas en el código. La resolución pasa siempre por las funciones de base de datos.

<!-- BEGIN:agent-rules -->
# Verifica antes de asumir

Las versiones de este proyecto pueden diferir de tus datos de entrenamiento. Consulta la documentación en `node_modules/` antes de escribir código contra Fastify, Zod o el SDK de Supabase. Atiende los avisos de deprecación.

Las tarifas de proveedores (ElevenLabs, Telnyx, Meta) cambian trimestralmente y **nunca se escriben literales en el código**: viven en tablas de configuración versionadas por fecha de vigencia.
<!-- END:agent-rules -->
