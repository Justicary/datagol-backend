# Lista de Espera y Confirmación Masiva — contrato para consumidores

Fuente de verdad del contrato HTTP de la feature de Lista de Espera (Waitlist)
y Confirmación Masiva de Citas. `datagol-frontend` referencia este documento
en vez de duplicar shapes de request/response — cualquier cambio de contrato
se hace aquí primero.

Documento hermano de `docs/tasks/waitlist_confirmacion_masiva.md` (el diseño
original, con el diagrama de flujo completo) y `db/schema.md` (esquema
completo de tablas). Este documento cubre exclusivamente lo que el dashboard
necesita saber: qué rutas existen, qué rutas **no** existen y por qué, shapes
exactos, y las decisiones de diseño que le importan a un cliente HTTP.

Toda la implementación descrita aquí está construida y verificada contra
Supabase real (migraciones 64-67, 100+ pruebas de integración pasando).

---

## 1. Convenciones generales

- **Feature gate:** toda ruta de esta sección exige la feature `waitlist`
  habilitada (planes `elite`/`enterprise`). Sin ella: `403 { success: false,
  error: string, requiredFeature: 'waitlist' }`, antes de evaluar cualquier
  otra cosa. En planes inferiores, el dashboard debe mostrar el tab con
  candado/badge de upgrade — no hay nada que consultar hasta que la
  organización tenga el plan correcto.
- **Permisos:** `view_waitlist` (lectura) y `manage_waitlist`
  (escritura/acciones) — ver `src/types/permission-keys.ts`. Todo rol
  (`viewer`/`member`/`admin`/`owner`) tiene `view_waitlist` por defecto; solo
  `admin`/`owner` tienen `manage_waitlist`. Un permiso insuficiente devuelve
  `403 { success: false, error: string }`.
- **Auth:** `Authorization: Bearer <jwt>` de Supabase Auth, igual que el
  resto de `/api/organizations/:id/...`. `:id` es la organización
  autenticada, nunca se infiere de otra parte.
- **Envoltura de respuesta:** todo 2xx trae `{ success: true, data: ... }`;
  todo error trae `{ success: false, error: string, requiredFeature?:
  string }`.
- **Base de rutas:** `/api/organizations/:id/...`, mismo prefijo que el resto
  del dashboard (`contacts-crm.ts`, etc.) — esta feature no vive bajo
  `/api/admin/...` (esa carpeta es exclusiva de superadmin de plataforma).

Implementación: `src/routes/waitlist-admin.ts` (listado),
`src/routes/appointments-admin.ts` (confirmación masiva).

---

## 2. Modelo de datos: `appointment_waitlist`

Tabla nueva (migraciones `64_appointment_waitlist.sql`,
`65_appointment_waitlist_idempotency.sql`,
`66_appointment_waitlist_offered_slot.sql`). Columnas que el listado del §3.1
devuelve:

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | |
| `organization_id` | `uuid` | |
| `contact_id` | `uuid` \| `null` | Referencia a `contacts`, si se pudo resolver. |
| `call_log_id` | `uuid` \| `null` | Casi siempre `null` — la llamada en curso todavía no tiene fila en `call_logs` cuando se captura el waitlist (esa fila la crea el webhook post-llamada). |
| `conversation_id` | `string` \| `null` | Id de la conversación de ElevenLabs que originó el registro. |
| `customer_name`, `customer_phone`, `customer_email` | `string` | `customer_phone` siempre presente (es el canal de la oferta); `customer_email` opcional. |
| `party_size` | `integer` | **Solo informativo.** `appointments` no tiene columna de cupo/comensales, así que el motor de matchmaking NO filtra por este campo — solo empareja por fecha/hora. Píntalo en la UI, pero no prometas al usuario que afecta el emparejamiento. |
| `preferred_date_start`, `preferred_date_end` | `date` | Ventana de fechas que el prospecto pidió. |
| `preferred_time_start`, `preferred_time_end` | `time` \| `null` | Ventana horaria opcional dentro de esas fechas. `null` en ambos = cualquier horario del día sirve. |
| `status` | `enum` | Ver tabla de abajo. |
| `priority` | `enum` | `alta` \| `normal` \| `baja`. `alta` se asigna automáticamente si el teléfono/correo ya pertenecía a un contacto existente en el CRM al momento de anotarse (ver §5 sobre la limitación de "hot lead"). |
| `offered_appointment_id` | `uuid` \| `null` | Se llena cuando la oferta se confirma y se crea la cita real en `appointments`. |
| `offered_at`, `offer_expires_at` | `timestamptz` \| `null` | Cuándo se hizo la última oferta y cuándo vence (TTL configurable por organización, default 15 min — `integration_settings.waitlist_ttl_minutes`). |
| `offered_slot_start`, `offered_slot_end` | `timestamptz` \| `null` | El horario **específico** que se ofertó (distinto de `preferred_date_start/end`, que es la ventana amplia solicitada). |
| `notification_channel` | `enum` | `whatsapp` \| `voice` \| `sms` (SMS no implementado todavía — reservado). Indica por qué canal se hizo/hará la oferta. |
| `notes` | `string` \| `null` | |
| `created_at`, `updated_at` | `timestamptz` | |

**No se devuelve:** `offer_token_hash` (hash del token del link de
confirmación) — se excluye explícitamente del `SELECT` del endpoint de
listado. No tiene uso legítimo en el dashboard.

### Estados (`status`)

```
pendiente → ofertada → confirmada
                     ↘ rechazada
                     ↘ expirada  (vuelve a intentar con el siguiente candidato)
   (cualquiera) → cancelada
```

| Estado | Significado |
|---|---|
| `pendiente` | En cola, esperando que se libere un cupo que calce. |
| `ofertada` | Se le ofreció un cupo específico; esperando respuesta antes de `offer_expires_at`. |
| `confirmada` | Aceptó — ya existe una cita real en `appointments` (`offered_appointment_id`). |
| `rechazada` | Rechazó explícitamente la oferta (vía el link de confirmación). |
| `expirada` | Nadie respondió antes del TTL — el sweep automático la marcó y ya intentó promover al siguiente candidato. |
| `cancelada` | Reservado para cancelación manual del registro de waitlist en sí (no de una cita). |

---

## 3. Endpoints consumibles por el dashboard

### 3.1 `GET /api/organizations/:id/waitlist`

Listado paginado de la cola de espera. Permiso: `view_waitlist`.

**Query params** (todos opcionales):

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `status` | string, coma-separado | `pendiente,ofertada` | Cualquier combinación de los 6 estados. Ejemplo: `?status=confirmada,rechazada,expirada,cancelada` para una pestaña de historial. Un valor inválido responde `400`. |
| `limit` | integer 1-100 | `50` | |
| `offset` | integer ≥0 | `0` | |

`200 { success: true, data: { items: WaitlistRow[], total: number, limit: number, offset: number } }`

**Orden:** `created_at` ascendente (FIFO) dentro del filtro de `status` — **no**
es el mismo orden que usa el motor de matchmaking para decidir a quién
ofertar (ese orden intercala prioridad con antigüedad y no es expresable
como `ORDER BY` de columna sin una vista dedicada). El campo `priority`
viaja en cada fila para que el frontend lo pinte como badge — no asumas que
el orden de la lista ya refleja prioridad.

**Por qué no hay más filtros (fecha, teléfono, texto libre):** no había un
caso de uso concreto que los pidiera al construir este endpoint. Si el
dashboard los necesita, es un cambio pequeño y aislado — pídelo antes de
intentar filtrar client-side sobre una lista ya paginada (con 50-100 filas
por página, un filtro en el cliente solo vería la página actual, no la cola
completa).

### 3.2 `POST /api/organizations/:id/appointments/bulk-confirm`

Dispara una solicitud de confirmación de asistencia (WhatsApp o llamada de
voz) a todas las citas elegibles de una fecha. Permiso: `manage_waitlist`.

Body: `{ date: string }` — formato `YYYY-MM-DD`. Formato inválido → `400`.

`200 { success: true, queued: number }` — `queued` es cuántas citas se
encolaron para notificación, no cuántas ya se enviaron (el envío real ocurre
de forma asíncrona, ver §5).

**Elegibilidad** (todas deben cumplirse):
- `status` es `programada` o `confirmada` (no `cancelada`/`completada`/`no_asistio`/`reprogramada`).
- Tiene `customer_phone` (sin teléfono no hay a quién notificar).
- `confirmation_requested_at` es `null` — si ya se le pidió confirmar una vez, un segundo `POST` para la misma fecha no la vuelve a encolar. **No hay endpoint de "reenviar"** en esta versión; si el negocio necesita insistir, es trabajo futuro.
- `start_time` cae dentro del día **local de la organización** indicado en `date` — calculado con la zona horaria real de `organizations.timezone`, no medianoche UTC del servidor. Una cita a las 23:50 hora local sigue contando para ese día aunque en UTC ya sea el día siguiente.

**Qué pasa después:** cada cita encolada dispara, de forma asíncrona,
WhatsApp (si hay ventana de servicio de 24h abierta con ese contacto) o una
llamada de voz de respaldo. Marca `appointments.confirmation_requested_at`
cuando la notificación sale. **No hay un botón de aceptar/rechazar propio
para esta notificación** — ver §4 para el porqué y qué hacer si el cliente
responde que no asistirá.

---

## 4. Lo que el frontend NO debe construir

Dos piezas de esta feature son HTTP pero **no** las consume el dashboard —
documentadas aquí para que nadie las reconstruya por accidente pensando que
faltan.

### 4.1 Tool routes (`/tools/:webhookToken/waitlist`, extensión de `/availability`)

Las invoca el agente de voz de ElevenLabs **durante la llamada**, autenticadas
con `x-tool-secret` (no con sesión de usuario). El dashboard nunca las llama
directamente. Si te preguntas cómo un prospecto termina en la cola sin que
nadie haya usado el dashboard: es por aquí — el agente detecta que no hay
horarios (`availability` ahora regresa `waitlistAvailable: true` cuando la
organización tiene la feature) y llama a este tool para anotarlo.

### 4.2 Página pública de confirmación (`GET/POST /api/waitlist/:offerToken[/confirmar|/rechazar]`)

Cuando se libera un cupo, el motor de matchmaking le manda al candidato un
WhatsApp con un link de confirmación de un clic. **Ese link apunta a una
página HTML servida directamente por `datagol-backend`, no a una ruta de
`datagol-frontend`.**

**Por qué no es una página del frontend:** el link lo abre el cliente final
(no un usuario del dashboard) desde el navegador in-app de WhatsApp, sin
sesión de ningún tipo — la autenticación completa es la posesión del token
de 256 bits en la URL. Es un patrón deliberadamente distinto al de invitación
de miembros (que sí resuelve en el frontend): acá no hay nada que el
dashboard deba renderizar ni ningún estado de sesión que gestionar. Construir
una página equivalente en el frontend sería trabajo duplicado sin ganancia.

**Lo único relevante para el dashboard:** cuando una oferta se confirma
desde ese link, aparece una fila nueva en `appointments` (con
`status: 'confirmada'`) igual que cualquier otra cita — no necesita
tratamiento especial en la UI de citas. Y `appointment_waitlist.status` pasa
a `confirmada`/`rechazada`, visible en el listado del §3.1.

---

## 5. Comportamiento asíncrono relevante

Estados de `appointment_waitlist` y `appointments.confirmation_requested_at`
cambian **sin que ningún usuario del dashboard haga nada** — vale la pena
que el frontend lo sepa para no tratarlo como un bug si un refresh muestra
un estado distinto al de hace un minuto:

- **Motor de matchmaking** (`waitlist-engine.ts`): se dispara al cancelarse
  una cita (desde el dashboard o por voz), busca al mejor candidato
  `pendiente` que calce fecha/hora, y lo pasa a `ofertada`.
- **Sweep de expiración**: corre cada 5 minutos. Cualquier oferta `ofertada`
  cuyo `offer_expires_at` ya pasó se marca `expirada` y se promueve
  automáticamente al siguiente candidato — puede generar una nueva fila
  `ofertada` para otro prospecto sin ninguna acción humana de por medio.
- **Limitación conocida de "hot lead":** el documento de diseño original
  planteaba prioridad `alta` para llamadas clasificadas como prospecto
  caliente. Esa clasificación (`leads.temperature`) se calcula *después* de
  colgar — no existe todavía en el momento en que se captura el registro de
  waitlist (que ocurre *durante* la llamada). Por eso `priority: 'alta'` hoy
  solo refleja "el contacto ya existía en el CRM", no sentimiento de la
  llamada en curso.

---

## 6. Checklist práctico de cableado

- [ ] Tab "Lista de Espera" con candado/badge de upgrade cuando `waitlist` no está en `request.features` (mismo patrón que cualquier otro tab gateado por feature, ej. catálogo).
- [ ] Tabla alimentada por `GET .../waitlist`, con badge de `priority` y `status` (no asumir que el orden de la lista ya refleja prioridad — ver §3.1).
- [ ] Filtro/pestaña de "historial" pasando `?status=confirmada,rechazada,expirada,cancelada`.
- [ ] Acción de confirmación masiva: selector de fecha + botón que llama `POST .../appointments/bulk-confirm`; mostrar `queued` como "se notificó a N citas", no como confirmación real (el envío es asíncrono).
- [ ] Ningún componente nuevo para el link de WhatsApp ni para el tool de voz — ver §4.
- [ ] Manejar `403 { requiredFeature: 'waitlist' }` y `403` por permiso insuficiente con los mismos componentes que ya existen para otras features/permisos gateados.
