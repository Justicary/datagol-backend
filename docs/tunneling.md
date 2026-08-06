# Guía de Pruebas de Llamadas en Vivo con Tunneling

Esta guía detalla los pasos para exponer tu servidor backend local Fastify (`http://localhost:3000`) a Internet de forma segura con HTTPS para probar webhooks en tiempo real de **Vapi AI**, consulta a la **Base de Conocimientos (RAG)**, **Agendamiento en Cal.com** y **Procesamiento Asíncrono pos-llamada**.

---

## 🛠️ Herramientas de Tunneling Disponibles

El entorno cuenta con dos opciones listas para usarse:

1. **Cloudflare Tunnel (`cloudflared`)** *(Opción Recomendada)*:
   - **Ventajas**: Rápido, extremadamente estable, conexión HTTPS nativa sin páginas intermedias de advertencia.
   - **Ubicación**: Instalado nativamente en `/usr/local/bin/cloudflared`.

2. **Localtunnel (`npx localtunnel`)**:
   - **Ventajas**: No requiere instalación local permanente, funciona vía `npx`.

---

## 🚀 Pasos para Iniciar las Pruebas

### 1. Iniciar los servicios locales

Asegúrate de que Redis y el servidor backend Fastify se encuentren activos:

```bash
# Iniciar servidor Redis local
sudo service redis-server start

# Iniciar servidor backend Fastify en modo desarrollo
pnpm dev
```

El servidor estará escuchando en `http://localhost:3000`.

---

### 2. Levantar el Túnel Público HTTPS

Abre una nueva terminal en la raíz del proyecto y ejecuta la opción de tu preferencia:

#### Opción A: Usando Cloudflare Tunnel (Recomendado)

Vía pnpm script:
```bash
pnpm tunnel
```

O comando directo:
```bash
cloudflared tunnel --url http://localhost:3000
```

*Verás una salida similar a esta en la consola:*
```text
2026-07-27T18:55:00Z INF +-----------------------------------------------------------------------------------+
2026-07-27T18:55:00Z INF | Your quick Tunnel has been created! Visit it at:                                  |
2026-07-27T18:55:00Z INF | https://random-subdomain.trycloudflare.com                                       |
2026-07-27T18:55:00Z INF +-----------------------------------------------------------------------------------+
```

Copia la URL `https://random-subdomain.trycloudflare.com`.

---

#### Opción B: Usando Localtunnel

Vía pnpm script:
```bash
pnpm tunnel:lt
```

O comando directo:
```bash
npx localtunnel --port 3000
```

*Verás una URL como:*
```text
your url is: https://funny-cat-42.loca.lt
```

---

### 3. Verificar el Túnel Público

Abre tu navegador o ejecuta en la terminal para confirmar la conectividad:

```bash
curl https://random-subdomain.trycloudflare.com/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "service": "datagol-backend",
  "database": "connected",
  "timestamp": "2026-07-27T18:56:00.000Z"
}
```

---

## ⚙️ Configuración del Webhook en Vapi AI Dashboard

1. Ingresa a la plataforma de [Vapi AI Dashboard](https://dashboard.vapi.ai).
2. Ve a **Assistants** -> Selecciona tu asistente o ve a **Account Settings / Server URL**.
3. En el campo **Server URL** o **Webhook URL**, pega la URL completa de tu endpoint:

```text
https://<TU_SUBDOMINIO>.trycloudflare.com/api/vapi/webhook
```

*(Sustituye `<TU_SUBDOMINIO>` por la URL generada en el paso 2).*

---

## 📞 Configuración de Herramientas (Tools) en Vapi AI

Para probar las llamadas en tiempo real con integración RAG y Calendario, registra las siguientes herramientas en tu asistente de Vapi:

### 1. Herramienta `searchKnowledgeBase` (Consulta RAG)
- **Name**: `searchKnowledgeBase`
- **Description**: Consulta la base de conocimiento para responder preguntas del cliente.
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Pregunta o consulta del cliente" }
    },
    "required": ["query"]
  }
  ```

### 2. Herramienta `checkAvailability` (Consultar Calendario)
- **Name**: `checkAvailability`
- **Description**: Revisa la disponibilidad de horarios en Cal.com.
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "eventTypeId": { "type": "number" },
      "startTime": { "type": "string", "description": "Fecha inicial ISO" },
      "endTime": { "type": "string", "description": "Fecha final ISO" }
    },
    "required": ["eventTypeId", "startTime", "endTime"]
  }
  ```

### 3. Herramienta `bookAppointment` (Agendar Cita)
- **Name**: `bookAppointment`
- **Description**: Reserva una cita en Cal.com.
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "organizationId": { "type": "string" },
      "eventTypeId": { "type": "number" },
      "customerName": { "type": "string" },
      "customerPhone": { "type": "string" },
      "startTime": { "type": "string", "description": "Fecha y hora reservada ISO" }
    },
    "required": ["organizationId", "eventTypeId", "customerName", "customerPhone", "startTime"]
  }
  ```

---

## 🔍 Flujo de Prueba de una Llamada en Vivo

1. Haz clic en **Test Call** o marca al número asociado al agente de Vapi.
2. Durante la llamada:
   - Hazle preguntas sobre tu negocio -> Vapi invocará `tool-calls` (`searchKnowledgeBase`) enviando la respuesta al agente de voz.
   - Pide agendar una cita -> Vapi invocará `checkAvailability` y `bookAppointment`.
3. Al colgar la llamada:
   - Vapi enviará el evento `end-of-call-report`.
   - Tu backend registrará la llamada inicial en Supabase (`call_logs`).
   - Se encolará el trabajo asíncrono en BullMQ.
   - OpenAI (`gpt-4o-mini`) analizará la transcripción y clasificará el sentimiento.
   - Resend enviará un correo electrónico con el resumen ejecutivo de la llamada a la organización asociada.
