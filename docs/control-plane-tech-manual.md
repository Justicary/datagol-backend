# Manual Técnico — Plano de Control y Licenciamiento (Datagol Backend)

Documento hermano de [`docs/tasks/control-plane-backend-datagol.md`](tasks/control-plane-backend-datagol.md) (el diseño
original) y [`db/schema.md`](../db/schema.md). Este manual cubre lo que alguien
operando, desplegando o extendiendo el sistema necesita saber: qué corre
dónde, qué endpoints existen, el contrato exacto del latido, y las
decisiones de diseño que no son obvias leyendo el código.

Toda la implementación descrita aquí está construida y verificada contra
Supabase real (migraciones `55`, `68`, `69`; ~35 pruebas de integración
pasando).

---

## 1. Arquitectura: un repositorio, dos comportamientos

El mismo repositorio (`datagol-api`) produce dos comportamientos según la
variable de entorno `CONTROL_PLANE`:

| `CONTROL_PLANE` | Dónde corre | Qué registra |
|---|---|---|
| `true` | `api.datagol.net` (Datagol mismo) | `/control/**` + `/status/**` + todo lo operativo |
| `false` (default) | Cada instalación cliente | Solo lo operativo + el cliente de licencia |

El cliente de licencia (verificación local, degradación por etapas, latido
diario) se registra **en las dos configuraciones** — la propia instancia
operativa de Datagol también es "un cliente" de su plano de control.

```
                    ┌─────────────────────────┐
                    │   api.datagol.net        │
                    │   CONTROL_PLANE=true     │
                    │                          │
                    │  /control/licenses       │  emite/revoca/rota
                    │  /control/customers      │  registro comercial
                    │  /control/deployments    │  provisión
                    │  /control/fleet          │  salud de la flota
                    │  /control/contracts      │  firma con OTP
                    │  /control/.../heartbeat  │◄─┐ recibe latidos
                    │  /status/:token          │  │ y renueva el token
                    └──────────────────────────┘  │
                                                   │ POST diario (pg-boss)
                    ┌──────────────────────────┐  │ Authorization: Bearer <jwt>
                    │  Instalación cliente      │  │
                    │  CONTROL_PLANE=false      │──┘
                    │                          │
                    │  plugins/license.ts      │  verifica localmente,
                    │  (verificación LOCAL,    │  sin red, cada hora
                    │   sin red, cada hora)    │
                    │  jobs/                   │
                    │  send-license-heartbeat  │
                    └──────────────────────────┘
```

### Dos principios que gobiernan todo el diseño

1. **La licencia nunca apaga la voz.** `routes/tools/**` (voz, WhatsApp,
   agendamiento) no importa nada de este módulo. No hay un `if` que lo
   conecte — es una garantía de ausencia de código, no una condición que
   "por ahora" no dispara. La prueba central de la suite (`license-degradation.test.ts`)
   ejercita exactamente esto: licencia revocada, sin latido, y una llamada
   de `routes/tools/**` sigue respondiendo 200.
2. **El latido lleva solo agregados.** `services/license-heartbeat-payload.ts`
   construye el payload contra un esquema Zod `.strict()` — cualquier campo
   fuera de esa lista cerrada (nombres, teléfonos, transcripciones) se
   rechaza, tanto al construirlo como al recibirlo. Es una restricción legal
   (LFPDPPP), no una preferencia de diseño.

---

## 2. Modelo de datos

### 2.1 Exclusivo del plano de control (`55_control_plane_datagol.sql`)

**Nunca se aplica en una instalación cliente.** Tablas: `customers`,
`deployments`, `contracts`, `licenses`, `license_heartbeats`,
`provisioning_tasks` / `provisioning_task_templates`, `deployment_events`.
Vistas: `v_fleet_health`, `v_provisioning_progress`, `v_recurring_revenue`.
Todas con RLS vía `is_platform_admin()` — están fuera del alcance de
cualquier usuario de organización.

`69_control_plane_contract_otp.sql` añade `contract_otp_codes` (también
exclusiva del plano de control): el código de 6 dígitos hasheado, nunca en
claro, para la firma de contratos. `55_...` ya trae
`contracts.verification_method`/`verified_at`, pero no el código en sí — de
ahí la migración separada en vez de tocar `55_...`.

### 2.2 En TODA instalación (`68_license_client_state.sql`)

`license_client_state` es una tabla singleton (`id = true`, una sola fila)
que vive en cada instalación — incluida la operativa de Datagol. Guarda el
JWT vigente de ESTA instalación y la bitácora de su último latido
(`last_heartbeat_sent_at`, `last_heartbeat_ok`, `heartbeat_retry_count`).
Es lo que `plugins/license.ts` lee al arrancar; sin esta tabla, un cliente
no podría verificar su propia licencia sin depender del plano de control
en cada arranque.

---

## 3. Firma y verificación (Fase A/B)

- **Algoritmo:** Ed25519 (EdDSA) vía [`jose`](https://github.com/panva/jose)
  — dependencia nueva, justificada: implementar validación de firma/claims/expiración
  a mano es exactamente el tipo de código que un mutante de Stryker debe
  poder acorralar, y `jose` es el estándar de facto, ESM-nativo.
- **Llave privada** (`CONTROL_PLANE_SIGNING_KEYS`): solo en `api.datagol.net`.
  JSON `{ "<key_version>": "<pem privada>" }`. Se monta como variable de
  entorno desde el gestor de secretos del proveedor de nube al desplegar
  (Secret Manager → Cloud Run) — no se introduce un SDK de nube nuevo para
  esto.
- **Llaves públicas** (`LICENSE_PUBLIC_KEYS`): en TODA instalación. Mismo
  formato JSON, puede tener varias entradas a la vez durante una rotación —
  la versión activa la decide el `kid` del encabezado del JWT, no un valor
  fijo.
- **Verificación:** `lib/license-signing.ts#verifyLicenseToken` — 100% local,
  cero llamadas de red. Es la pieza que permite el principio 1 de la
  sección 1: si `api.datagol.net` está caído, un cliente sigue confiando en
  su propio JWT hasta que expire.

### Claims del token (`LicenseTokenClaims`)

```ts
{
  deploymentId, deploymentSlug, planKey,
  features: string[],
  fingerprint: string | null,
  warnAfterDays, limitFeaturesAfterDays, lockDashboardAfterDays,
}
```

Los tres umbrales de degradación viajan **en el token**, no en el código —
un cliente no tiene acceso a la tabla `licenses` del plano de control para
leerlos de ahí. Se pueden fijar por licencia al emitirla
(`POST /control/licenses`); si se omiten, `services/license-service.ts`
aplica los valores por defecto de `licenses` (`55_...`): vigencia del JWT
**90 días**, `warnAfterDays` **7**, `limitFeaturesAfterDays` **15**,
`lockDashboardAfterDays` **30**. El propio latido diario exitoso renueva
la vigencia de 90 días — en operación normal, un cliente nunca se acerca a
esa fecha; solo importa cuando el latido lleva días fallando.

---

## 4. Endpoints del plano de control (`CONTROL_PLANE=true`)

Todos bajo `isPlatformAdmin` (`lib/platform-admin.ts`), salvo el receptor de
latido, que se autentica con el propio JWT de la instalación.

### 4.1 Licencias — `src/routes/control/licenses.ts`

| Método | Ruta | Nota |
|---|---|---|
| `POST` | `/control/licenses` | Emite. 409 si ya hay una licencia activa (usar rotate). |
| `POST` | `/control/licenses/:id/revoke` | Requiere `reason`. |
| `POST` | `/control/licenses/:id/rotate` | Renueva **la misma fila** (mismo `id`), sin pasar por `revoked_at`. |
| `GET` | `/control/licenses/:id` | Nunca reexpone el `token` — solo se entrega en la emisión/rotación. |

Toda operación de escritura inserta en `deployment_events`
(`licencia_emitida`, `licencia_revocada`, `renovado`).

### 4.2 Registro comercial — `customers.ts`, `deployments.ts`, `fleet.ts`

`POST/GET/PATCH /control/customers`, `POST/GET/PATCH /control/deployments`,
`POST /control/deployments/:id/status`, `GET .../tasks`, `PATCH
.../tasks/:taskKey`, `GET /control/fleet` (`v_fleet_health`), `GET
/control/revenue` (`v_recurring_revenue`).

Al transicionar un despliegue a `aprovisionando`,
`services/deployment-service.ts#instantiateProvisioningTasks` copia
`provisioning_task_templates` filtrando por `applies_when`: una plantilla
sin valor aplica siempre; con valor, debe coincidir con el `plan_key` del
despliegue o con una de sus features habilitadas (`plan_features`).

### 4.3 Contratos — `contracts.ts`

| Método | Ruta |
|---|---|
| `POST` | `/control/deployments/:id/contract` |
| `POST` | `/control/contracts/:id/send-otp` |
| `POST` | `/control/contracts/:id/sign` |
| `GET` | `/control/contracts/:id/pdf` |

El PDF se genera con [`pdfkit`](https://pdfkit.org/) (dependencia nueva,
pura JS, sin binarios nativos), se hashea con SHA-256 exacto sobre el
buffer generado, y se sube al bucket privado `control-plane-contracts`
(Supabase Storage). El OTP es de 6 dígitos, **solo por correo** (`email_otp`
vía Resend) en esta entrega — el esquema soporta `sms_otp` pero no está
implementado (no hay proveedor de SMS transaccional cableado en este
repositorio).

Firmar actualiza `contracts.signed_at`; el trigger `forbid_signed_contract_mutation`
de `55_...` impide cualquier UPDATE posterior a un contrato firmado — el
servicio traduce ese fallo de Postgres a un 409/400 legible en vez de
dejarlo pasar crudo.

### 4.4 Latido — `heartbeat.ts` (única ruta sin `isPlatformAdmin`)

`POST /control/deployments/:id/heartbeat` — autenticado con
`Authorization: Bearer <jwt-de-la-instalación>`. Dos verificaciones
independientes antes de aceptar el payload:

1. El JWT verifica localmente (firma + `deploymentId` coincide con `:id`).
   Falla → `401`.
2. **Existe una licencia NO revocada** para ese despliegue en la base. Un
   JWT revocado sigue siendo criptográficamente válido hasta su expiración
   natural — la revocación es un estado de la base, no del propio token.
   Sin esta segunda verificación, una licencia revocada podría
   auto-renovarse por latido y deshacer la revocación. Falla → también
   `401` (mismo código que el paso 1: el cliente no puede distinguir "tu
   JWT está mal firmado" de "tu licencia fue revocada" solo por el status
   code, a propósito — ninguna de las dos cosas debe volverse un vector de
   sondeo).

El cuerpo se valida contra `licenseHeartbeatPayloadSchema` (ver §5); si no
cumple, `400` sin insertar nada. Éxito → inserta en `license_heartbeats`,
actualiza `licenses.last_heartbeat_at`, y responde `200` con un token
renovado (reutiliza `rotateLicense`, misma mecánica que
`POST /control/licenses/:id/rotate` — es la única otra situación, además de
la emisión, en que el `token` completo viaja en una respuesta; `GET
/control/licenses/:id` §4.1 sigue sin reexponerlo nunca).

**Cómo se siembra el primer token de una instalación nueva:** no hay un
endpoint de "provisión automática" todavía. El flujo actual es manual: se
emite la licencia con `POST /control/licenses` (control plane), y el
`token` de la respuesta se inserta a mano en la fila `license_client_state`
de la instalación nueva (vía consola de Supabase o un script de
despliegue) antes del primer arranque. Automatizar esto — que el
aprovisionamiento de infraestructura llame a `issueLicense` y escriba el
resultado directamente en la base del cliente recién creado — es trabajo
futuro, no cubierto por esta entrega.

---

## 5. El contrato del latido (Fase B.2)

`services/license-heartbeat-payload.ts` — esquema Zod `.strict()` en cada
nivel, para que ningún campo fuera de esta lista pueda colarse:

```ts
{
  health: {
    installedVersion, databaseOk, queueOk,
    toolLatencyP95Ms,   // ventana en memoria de 500 muestras de routes/tools/**
    errorCount5xx,      // contador en memoria, se drena en cada envío
  },
  periodCounts: { conversations, appointments, prospects },  // COUNT(*), nunca filas
  usageUsdByProvider: Record<string, number>,                // SUM(amount_usd) por provider
  activeFeatures: string[],
  seatsUsed: number,
  fingerprint: string | null,
}
```

**Límite conocido:** `toolLatencyP95Ms` y `errorCount5xx` son trackers en
memoria del propio proceso (`lib/tool-latency-tracker.ts`,
`lib/error-counter.ts`) — se reinician si el proceso reinicia entre
latidos, y no se agregan entre instancias si el servicio corre con más de
un réplica. Suficiente para el propósito del latido (una señal de salud
aproximada), insuficiente como sistema de observabilidad real — eso es
alcance de AGENTS.md §14, no de esta tarea.

**Job cliente:** `jobs/send-license-heartbeat.ts`, cola `send-license-heartbeat`,
`pg-boss.schedule('0 6 * * *', ...)`. `createQueue({ retryLimit: 5,
retryBackoff: true })` — un fallo de red nunca bloquea nada más; solo se
reintenta con retroceso exponencial y se deja constancia en
`license_client_state.last_heartbeat_error`.

---

## 6. Cliente de licencia y degradación por etapas (Fase B)

`plugins/license.ts` se registra en TODA instalación. Al arrancar (y cada
hora vía `setInterval`, sin red):

1. Lee `license_client_state` (la fila local de la instalación).
2. Verifica el JWT con `verifyLicenseToken` — sin red.
3. Decora `fastify.license: LicenseState` con el resultado.

**Nunca lanza.** Sin fila, con un token corrupto, expirado o de una versión
de llave desconocida: el plugin igual termina de registrarse y
`fastify.license.status` queda en `sin_token`/`expirada`, nunca tumba
`buildApp()`.

`lib/license-degradation.ts#resolveLicenseStage` calcula la etapa a partir
de los umbrales del token y de cuántos días pasaron desde el último latido
exitoso (o desde la emisión, si nunca hubo uno):

| Etapa | Umbral (viene del token) | Efecto |
|---|---|---|
| `normal` | < `warnAfterDays` | Ninguno |
| `aviso` | ≥ `warnAfterDays` | Aviso en dashboard, operación intacta |
| `features_limitadas` | ≥ `limitFeaturesAfterDays` | `requireLicenseStageAtMost('normal')` rechaza reportes/outbound/exportación con 403 |
| `dashboard_bloqueado` | ≥ `lockDashboardAfterDays`, o sin licencia válida | Dashboard bloqueado |

`requireLicenseStageAtMost(stage)` es un `preHandler` que se usa
selectivamente en rutas administrativas — **nunca** en `routes/tools/**`.

---

## 7. Página de estatus pública (Fase E)

`GET /status/:statusToken` — sin sesión, resuelve por
`deployments.status_token` (opaco, rotable, `unique`). Solo existe cuando
`CONTROL_PLANE=true`: aunque la ruta no vive bajo el prefijo `/control/**`
(a propósito — es lo que visita el cliente final, no un administrador),
las tablas que consulta (`deployments`, `provisioning_tasks`) son
exclusivas del plano de control, así que registrarla en una instalación
cliente sería una ruta que nunca podría resolver nada.

Expone únicamente `trade_name`, el avance (`v_provisioning_progress`) y la
lista de tareas con responsable/estado — nunca montos, RFC ni notas
internas. Un token inválido y uno inexistente responden exactamente el
mismo 404, para no filtrar cuál de los dos es el caso. Límite de tasa en
memoria (`lib/rate-limiter.ts`) por IP y por token, independientes.

---

## 8. Variables de entorno nuevas

| Variable | ¿Falla el arranque si falta? | Notas |
|---|---|---|
| `CONTROL_PLANE` | Nunca — default `'false'` | Gatilla el registro de `/control/**` y `/status/**` en `app.ts`. |
| `CONTROL_PLANE_SIGNING_KEYS` | **Sí, pero solo si `CONTROL_PLANE=true`** | Exclusiva de `api.datagol.net`. JSON `{ key_version: pem_privada }`. Con la bandera en `true` y esta variable ausente, `validateEnv()` lanza y el proceso nunca llega a levantar (Fase F). En una instalación cliente (`CONTROL_PLANE=false`) no se valida ni se usa. |
| `LICENSE_PUBLIC_KEYS` | **Sí, si `CONTROL_PLANE=true`** (mismo chequeo que arriba, junto con `CONTROL_PLANE_SIGNING_KEYS`) · **No, en cliente** | JSON `{ key_version: pem_pública }`. En una instalación cliente, si falta, el arranque **continúa igual** — `verifyLicenseToken` simplemente reporta `llaves_publicas_no_configuradas` y `plugins/license.ts` deja `fastify.license.status` en el peor estado (nunca lanza; ver §6). Sin esta variable, ningún token — ni siquiera uno legítimo — puede verificarse. |
| `CONTROL_PLANE_URL` | Nunca | URL del plano de control al que esta instalación envía su latido diario. Sin ella, `jobs/send-license-heartbeat.ts` se omite en cada corrida (log informativo, sin reintentar, sin afectar nada más). |

**Nota de asimetría:** `LICENSE_PUBLIC_KEYS` es fail-fast en el plano de
control (porque ahí también corre el cliente de licencia sobre su propia
instancia operativa) pero nunca lo es en una instalación cliente — ahí
gobierna el principio 1 de la sección 1 por encima de la validación
estricta de arranque: preferir seguir sirviendo llamadas con la licencia
sin verificar, a rehusarse a arrancar.

---

## 9. Decisiones de diseño y límites conocidos

- **Rotación de licencia = UPDATE en la misma fila**, no revocar+crear. El
  índice único `ux_licenses_active` (una licencia no revocada por
  despliegue) así lo exige, y evita que cada renovación diaria genere un
  evento de revocación.
- **OTP solo por correo** en esta entrega. `sms_otp` está soportado por el
  esquema (`contract_otp_codes.channel`) pero no implementado — no hay
  proveedor de SMS transaccional cableado para esto en el repositorio.
- **Sin sweep de "latido ausente".** `v_fleet_health` ya calcula
  `dias_sin_latido`/`etapa_degradacion` bajo demanda (`GET /control/fleet`)
  — no se construyó un job que escriba un evento `latido_ausente` en
  `deployment_events` por cada instalación que deja de reportar, porque
  ninguna de las pruebas obligatorias del diseño original lo exige y
  añadirlo habría sido alcance no pedido.
- **`toolLatencyP95Ms`/`errorCount5xx` son aproximaciones en memoria** (ver
  §5) — correctos para una sola réplica, no agregados entre instancias.
- **`deployments.plan_key` es texto libre**, igual que `plans.key`
  operativo — no hay un CHECK constraint que los una. La resolución de
  features del token (`resolvePlanFeatures` en `license-service.ts`) asume
  que coincide con una fila real de `plan_features`; si no coincide, la
  licencia se emite con una lista de features vacía y se registra una
  advertencia, nunca se bloquea la emisión.
- **La siembra del primer token y la distribución de `LICENSE_PUBLIC_KEYS`
  son procesos manuales.** No existe todavía un paso automatizado de
  aprovisionamiento que, al crear una instalación cliente, le entregue su
  primer JWT ni que propague una rotación de llave pública a todas las
  instalaciones activas (ver la nota de siembra manual en §4.4). En una
  rotación real, hay que actualizar `LICENSE_PUBLIC_KEYS` en cada
  instalación cliente para que incluya la llave nueva **antes** de que
  `api.datagol.net` empiece a firmar con ella — de lo contrario, el primer
  latido posterior a la rotación llega firmado con una versión que esa
  instalación no reconoce todavía.

---

## 10. Pruebas

`__tests__/license-signing.test.ts`, `license-degradation.test.ts` (incluye
la prueba central: licencia revocada + sin latido + `routes/tools/**` sigue
en 200), `license-plugin.test.ts`, `license-heartbeat-payload-schema.test.ts`,
`rate-limiter.test.ts`, `tool-latency-and-error-counter.test.ts`,
`control-plane-flag-isolation.test.ts` (`CONTROL_PLANE=false` → 404 en
`/control/**`), `control-licenses-routes.test.ts`, `control-heartbeat-route.test.ts`,
`control-contracts-flow.test.ts`, `control-customers-deployments.test.ts`,
`status-route.test.ts`.

`stryker.config.json` incluye los archivos de firma/degradación/latido/OTP
en `mutate` — se verifican manualmente en ≥90% (categoría "seguridad y
aislamiento", AGENTS.md §10) mientras `thresholds.break` siga en `null`
para el resto del proyecto.

**Nota de higiene para quien añada pruebas aquí:** `plan_features` es una
tabla global compartida con planes reales (`pro`, `starter`, ...) — nunca
escribir/borrar filas de un `plan_key` real desde una prueba. Usar una
clave de plan inventada y exclusiva del archivo (ver el patrón
`FAKE_PLAN_KEY` en `control-licenses-routes.test.ts`). Un despiste aquí
puede borrar una fila de configuración legítima y producir fallas
intermitentes en pruebas de entitlements sin relación aparente.
