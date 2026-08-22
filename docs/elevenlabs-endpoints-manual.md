# Manual de Arquitectura y Configuración de Endpoints de ElevenLabs en Datagol API

Este documento es la **guía definitiva y única fuente de verdad** para entender y configurar todos los endpoints de comunicación entre **ElevenLabs ConvAI** y el backend de **Datagol API (`datagol-backend`)**.

---

## 🗺️ Mapa General de Integración

Existen **3 familias de endpoints** con propósitos, momentos de ejecución, mecanismos de autenticación y configuraciones totalmente independientes en la consola de ElevenLabs:

```mermaid
flowchart TD
    subgraph ElevenLabs["Plataforma ElevenLabs ConvAI"]
        Agent["Agente Conversacional (Voz/Chat)"]
        PostCallEngine["Motor de Análisis Post-Llamada"]
    end

    subgraph Frontend["Clientes / Frontend"]
        WebModal["Modal de Voz / Web Widget"]
    end

    subgraph DatagolAPI["Datagol Backend (Cloud Run)"]
        ToolsAPI["1. Tool Calls en Vivo\n/tools/:webhookToken/*"]
        WebhookAPI["2. Post-Call Webhook\n/webhooks/elevenlabs/:webhookToken"]
        SignedUrlAPI["3. Sesiones y Signed URLs\n/api/elevenlabs/signed-url"]
    end

    subgraph External["Servicios Externos / BD"]
        CalCom["Cal.com (Agenda)"]
        Supabase["Postgres / Vault / pg-boss"]
    end

    %% Flujos
    WebModal -->|Solicita Signed URL| SignedUrlAPI
    SignedUrlAPI -->|Solicita get_signed_url con API Key| ElevenLabs
    WebModal <-->|Media Streaming WebRTC / Audio| Agent

    Agent -->|Durante la llamada (HTTP POST + x-tool-secret)| ToolsAPI
    ToolsAPI <-->|Consulta slots / Crea citas| CalCom
    ToolsAPI <-->|Valida token y secreto| Supabase

    PostCallEngine -->|Al finalizar llamada (HTTP POST + HMAC)| WebhookAPI
    WebhookAPI -->|Valida firma HMAC y encola| Supabase
```

---

## 1. Familia 1: Tool Calls en Vivo (Server Tools / Webhook Tools)

### ¿Qué son y cuándo se ejecutan?
Son herramientas HTTP que el LLM del agente ejecuta **en tiempo real mientras el cliente habla por teléfono o chat** para consultar o modificar información en vivo (presupuesto contractual: **p95 < 300 ms**).

### Lista de Endpoints
Todas las rutas de herramientas comparten el prefijo `/tools/:webhookToken/`:

| Nombre en ElevenLabs | Método | Ruta del Endpoint | Propósito |
|---|---|---|---|
| `checkAvailability` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/availability` | Consulta horarios libres en Cal.com para un rango de fechas. |
| `bookAppointment` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/booking` | Agenda la cita en Cal.com y guarda el registro en `appointments`. |
| `getAppointment` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/appointment` | Consulta los detalles y horario de una cita existente agendada por el cliente. |
| `rescheduleAppointment` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/reschedule` | Reprograma una cita existente verificando identidad del cliente. |
| `cancelAppointment` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/cancel` | Cancela una cita existente a solicitud del cliente, verificando su identidad. |
| `getLocations` | `POST` | `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/locations` | Consulta la matriz, sucursales y direcciones físicas o de facturación del negocio. |

> **Nota sobre `<WEBHOOK_TOKEN>`**: Es el identificador alfanumérico público de enrutamiento asignado a cada organización en la columna `organizations.webhook_token` (ej. `b05e8d6ec8801a7124c989330104579c9490b3e06bf02a2bdf404d879564a831`). Permite a la API saber a qué cliente pertenece la llamada **antes** de leer el payload.

---

### Autenticación de las Tools
ElevenLabs **no** envía firmas HMAC en las Tools; únicamente permite inyectar cabeceras HTTP estáticas. Por tanto:
- **Header Requerido**: `x-tool-secret`
- **Valor**: Secreto estático compartido que se almacena en el Vault de Datagol bajo la clave `tool_webhook_secret` de `organization_secrets`.
- **Validación del Servidor**: Comprobación en tiempo constante (`timingSafeEqual`) contra `tool_webhook_secret`.

---

### Configuración en ElevenLabs (Paso a Paso)
1. Ve a **Conversational AI** → **Agents** → Selecciona tu Agente → Pestaña **Tools**.
2. Haz clic en **+ Add Tool** → **Webhook** (o edita una existente):

#### A) Configuración de `checkAvailability`:
* **Name**: `checkAvailability`
* **Description**: `Consulta los horarios disponibles en la agenda para una fecha o rango de fechas específico.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/availability`
* **Headers**:
  * Type: `Secret`
  * Header Name: `x-tool-secret`
  * Secret Value: `x-tool-secret` *(variable de entorno con el secreto de la organización)*
* **Request Body Parameters**:
  * `startTime` (string, ISO 8601 o fecha/hora)
  * `endTime` (string, ISO 8601 o fecha/hora)
  * `timeZone` (string, opcional, ej. `America/Mexico_City`)

#### B) Configuración de `bookAppointment`:
* **Name**: `bookAppointment`
* **Description**: `Confirma y reserva una cita en Cal.com v2, registrando permanentemente los datos en la base de datos.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/booking`
* **Headers**:
  * `x-tool-secret`: `<TOOL_SECRET>`
* **Request Body Parameters**:
  * `conversationId` (string, `{conversation_id}`)
  * `customerName` (string)
  * `customerPhone` (string, opcional si hay correo)
  * `customerEmail` (string, opcional si hay teléfono)
  * `startTime` (string)
  * `timeZone` (string, opcional)
  * `serviceAddress` (string, opcional)

#### C) Configuración de `getAppointment`:
* **Name**: `getAppointment`
* **Description**: `Consulta los detalles, fecha y horario de una cita existente agendada por el cliente cuando pregunte '¿A qué hora es mi cita?' o '¿Cuándo tengo mi cita?'. Requiere al menos el teléfono o correo con el que se agendó.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/appointment` *(o `/appointment-details`)*
* **Headers**:
  * `x-tool-secret`: `<TOOL_SECRET>`
* **Request Body Parameters**:
  * `customerPhone` (string, opcional)
  * `customerEmail` (string, opcional)
  * `customerName` (string, opcional)

#### D) Configuración de `rescheduleAppointment`:
* **Name**: `rescheduleAppointment`
* **Description**: `Permite reprogramar o modificar la fecha y hora de una cita previamente agendada.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/reschedule`
* **Headers**:
  * `x-tool-secret`: `<TOOL_SECRET>`
* **Request Body Parameters**:
  * `customerName` (string)
  * `customerEmail` (string, opcional)
  * `customerPhone` (string, opcional)
  * `newStartTime` (string)

#### E) Configuración de `cancelAppointment`:
* **Name**: `cancelAppointment`
* **Description**: `Cancela una cita previamente agendada a solicitud del cliente. Requiere el nombre completo y al menos el correo o teléfono con los que se agendó.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/cancel`
* **Headers**:
  * `x-tool-secret`: `<TOOL_SECRET>`
* **Request Body Parameters**:
  * `customerName` (string)
  * `customerEmail` (string, opcional)
  * `customerPhone` (string, opcional)
  * `reason` (string, opcional — motivo de la cancelación)

#### F) Configuración de `getLocations`:
* **Name**: `getLocations`
* **Description**: `Consulta la ubicación de la matriz, sucursales o dirección de facturación del negocio para informar al cliente cuando pregunte por direcciones, sedes o dónde estamos ubicados.`
* **Method**: `POST`
* **URL**: `https://api.datagol.net/tools/<WEBHOOK_TOKEN>/locations` *(o `/branches`)*
* **Headers**:
  * `x-tool-secret`: `<TOOL_SECRET>`
* **Request Body Parameters**:
  * `addressType` (string, opcional: `matriz`, `sucursal`, `facturacion`, `domicilio`, `servicio`)
  * `label` (string, opcional, ej. `Angelópolis`, `Centro`)

---

## 2. Familia 2: Post-Call Webhook (Fin de Llamada e Ingesta Asíncrona)

### ¿Qué es y cuándo se ejecuta?
Es el webhook que ElevenLabs dispara automáticamente **al terminar la conversación** y completarse el análisis de IA. Envía la transcripción completa, resumen, análisis de datos extraídos (*Data Collection*) y métricas de duración.

### Endpoint
* **Método**: `POST`
* **Ruta**: `https://api.datagol.net/webhooks/elevenlabs/<WEBHOOK_TOKEN>`

---

### Autenticación del Webhook
* **Mecanismo**: Criptográfico **HMAC SHA-256**.
* **Header enviado por ElevenLabs**: `ElevenLabs-Signature` (contiene `t=<timestamp>,v1=<hash>`).
* **Secreto utilizado**: `Signing Secret` de ElevenLabs (empieza con `wsec_...`), guardado en Datagol en `organization_secrets` bajo la clave `webhook_signing_secret`.
* **Validación del Servidor**:
  1. Resuelve la organización por `<WEBHOOK_TOKEN>`.
  2. Lee el cuerpo crudo (`rawBody`).
  3. Reconstruye el HMAC y valida la firma antes de procesar el JSON.
  4. Responde **200 OK** de inmediato y encola el trabajo pesado en `pg-boss` (`process-call-completed`).

---

### Configuración en ElevenLabs (Paso a Paso)
1. Ve a **Conversational AI** → **Agents** → Selecciona tu Agente.
2. Ve a la pestaña **Settings** → **Security** (o **Analysis** según la interfaz).
3. En la sección **Post-call Webhook**:
   * **Endpoint URL**: `https://api.datagol.net/webhooks/elevenlabs/<WEBHOOK_TOKEN>`
   * **Auth Method**: `HMAC`
   * **Signing Secret**: Copia el valor generado (ej. `wsec_...`) y asegúrate de aprovisionarlo en Datagol (`webhook_signing_secret`).
   * **Webhook Events**:
     * ✅ **Transcript** *(Debe estar ACTIVADO — envía el evento `post_call_transcription`)*
     * ❌ Audio *(Opcional / Desactivado salvo que se requiera almacenamiento de audio crudo)*
     * ❌ Call Initiation Failures *(Opcional)*
     * ❌ OpenTelemetry transcript payloads *(Desactivado)*
4. Haz clic en **Publish** en el agente.

---

## 3. Familia 3: Sesiones y Signed URLs (Inicialización desde Frontend)

### ¿Qué son y cuándo se ejecutan?
Son endpoints consumidos por nuestro propio frontend (`datagol-frontend` o widgets embebidos) para solicitar a ElevenLabs una **Signed URL de WebSocket/WebRTC** temporal para iniciar una conversación de voz sin exponer la API Key maestra en el navegador del usuario.

### Lista de Endpoints

| Método | Ruta | Uso |
|---|---|---|
| `GET` | `/api/elevenlabs/signed-url` | Genera una URL firmada de conexión WebRTC usando `ELEVENLABS_API_KEY` y `ELEVENLABS_AGENT_ID`. |
| `GET` | `/api/elevenlabs/inbound` | Alias de inicialización para clientes legacy / webhooks de entrada. |

---

## 📊 Cuadro Comparativo Resumen

| Característica | 1. Tool Calls (`/tools/...`) | 2. Post-Call Webhook (`/webhooks/...`) | 3. Signed URLs (`/api/elevenlabs/...`) |
|---|---|---|---|
| **Quién lo llama** | ElevenLabs (en vivo) | ElevenLabs (fin de llamada) | Navegador / Frontend |
| **Frecuencia** | Múltiples veces por llamada | 1 vez al colgar | 1 vez al iniciar llamada |
| **Cabecera de Seguridad** | `x-tool-secret` (Estático) | `ElevenLabs-Signature` (HMAC SHA-256) | Token de sesión / Origen autorizado |
| **Clave en Vault Datagol** | `tool_webhook_secret` | `webhook_signing_secret` | `elevenlabs_api_key` |
| **Dónde se configura** | Agente → **Tools** | Agente → **Settings → Security** | Consumido por el frontend |
| **Latencia esperada** | **< 300 ms** (Crítica) | Asíncrona (responde 200 y encola) | Estándar HTTP (< 500 ms) |

---

## 🔧 Comandos de Aprovisionamiento de Secretos (CLI)

Para registrar o sincronizar los secretos de una organización en Datagol:

```bash
# 1. Definir el token de enrutamiento de la organización (organizations.webhook_token)
pnpm tsx scripts/provision-org-secrets.ts webhook-token --org <ORGANIZATION_ID> --value "<WEBHOOK_TOKEN>"

# 2. Definir el secreto compartido para las Tools (x-tool-secret)
pnpm tsx scripts/provision-org-secrets.ts secret --org <ORGANIZATION_ID> --key tool_webhook_secret --value "<TOOL_SECRET>"

# 3. Definir el secreto de firma HMAC del Webhook Post-Llamada
pnpm tsx scripts/provision-org-secrets.ts secret --org <ORGANIZATION_ID> --key webhook_signing_secret --value "<SIGNING_SECRET_WSEC>"
```
