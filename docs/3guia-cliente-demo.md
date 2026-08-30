# Guía Práctica Paso a Paso: Creación y Despliegue de un Cliente DEMO

Esta guía práctica te acompaña paso a paso en la creación de tu **primer cliente de prueba** utilizando tu **iPad** para la venta/firma y tu **Laptop (Windows 11 con WSL2)** para la provisión técnica.

---

## 📋 Datos de Ejemplo para el Cliente Demo

Para esta prueba utilizaremos los siguientes datos (puedes ajustar el correo a uno que puedas consultar de inmediato):

| Campo | Valor de Prueba |
|---|---|
| **Nombre Comercial** | `Clínica Dental Demo` |
| **Razón Social** | `Dental Demo S.A. de C.V.` |
| **RFC** | `DDE200101ABC` |
| **Nombre del Contacto** | Tu Nombre |
| **Correo del Contacto** | `tu-correo@datagol.net` *(donde recibirás el código OTP)* |
| **Teléfono Móvil** | `+522221234567` |
| **Slug del Despliegue** | `demo-dental` |
| **Plan Contratado** | `pro` |
| **Retainer Mensual** | `$4,500.00 MXN` |

---

## 📱 PASO 1: En tu iPad (Onboarding y Firma Digital)

> **Objetivo:** Simular la experiencia del cliente frente a ti firmando el contrato.

### 1.1 Iniciar sesión en el Plano de Control
1. Abre Safari o Chrome en tu **iPad**.
2. Entra a la consola administrativa:
   * **Producción:** `https://app.datagol.net/admin/control`
   * **Desarrollo local en la misma red Wi-Fi:** `http://<IP_DE_TU_LAPTOP>:3000/admin/control`
3. Inicia sesión con tus credenciales de Superadmin.

### 1.2 Dar de alta al Cliente y su Despliegue
1. En el menú superior, pulsa en **"Nuevo Onboarding"** (o **"Crear Cliente"**).
2. Llena el formulario con los datos de ejemplo de la tabla anterior:
   * Nombre Comercial: `Clínica Dental Demo`
   * Razón Social: `Dental Demo S.A. de C.V.`
   * RFC: `DDE200101ABC`
   * Correo: Tu correo real para recibir el código.
   * Plan: `pro`
   * Slug: `demo-dental`
3. Pulsa en **"Guardar y Generar Contrato"**.

### 1.3 Firma del Contrato con OTP
1. El sistema enviará automáticamente un correo electrónico con un **código OTP de 6 dígitos**.
2. Abre la bandeja de entrada de tu correo en el iPad (o en tu teléfono móvil).
3. Copia el código de 6 dígitos e ingrésalo en la pantalla de firma.
4. Pulsa en **"Firmar y Confirmar Contrato"**.
5. Copia el enlace de estatus público que te arroja la pantalla:
   * `https://app.datagol.net/status/[STATUS_TOKEN]`
   * Ábrelo en otra pestaña del iPad: verás que la tarea **"Contrato firmado"** ya está en verde ✅ y el avance marca las tareas pendientes de infraestructura.
6. Copia el **Deployment ID (UUID)** generado (lo necesitarás en el Paso 2).

---

## 💻 PASO 2: En tu Laptop (Windows 11 con WSL2)

> **Objetivo:** Aprovisionar la base de datos, emitir la licencia comercial y preparar el despliegue.

Abre tu terminal de **Ubuntu / WSL2** en la carpeta del proyecto:
```bash
cd ~/proyectos/antigravity/datagol-backend
```

### 2.1 Preparar la Base de Datos del Cliente Demo
Tienes dos opciones para la base de datos del cliente demo:
* **Opción A (Nuevo Proyecto Supabase):** Crea un proyecto gratuito de prueba en [supabase.com](https://supabase.com) (ej. `demo-dental-db`) y copia su `DATABASE_URL` y sus API Keys.
* **Opción B (Base de datos local Postgres):** Si tienes un Postgres local para pruebas.

### 2.2 Ejecutar el Aprovisionamiento Automatizado
Ejecuta el comando CLI pasando el `Deployment ID` que obtuviste en el iPad:

```bash
npx tsx scripts/provision-client.ts \
  --deployment-id="<PEGA_AQUÍ_EL_UUID_DEL_DESPLIEGUE>" \
  --org-name="Clínica Dental Demo" \
  --org-email="contacto@dentaldemo.com" \
  --db-url="postgresql://postgres:TU_PASSWORD@db.xxx.supabase.co:5432/postgres" \
  --supabase-url="https://xxx.supabase.co" \
  --supabase-key="sb_secret_xxx" \
  --plan-key="pro"
```

**¿Qué verás en tu terminal en menos de 10 segundos?**
1. ✅ `Base de datos inicializada con DDL maestro.` (Aplica todas las tablas operativas).
2. ✅ `Organización creada con ID: <UUID_ORG>`
3. ✅ `Licencia comercial emitida y sembrada en license_client_state.`
4. ✅ `Tareas actualizadas en el Plano de Control: infra_desplegada, licencia_emitida, contrato_firmado.`
5. 📄 Se genera automáticamente en tu carpeta el archivo: `env-vars-demo-den.yaml`.

---

### 2.3 Configuración de Proveedores de Voz (ElevenLabs & Telnyx)

En el modelo Done-For-You (BYOK), el cliente o tú como operador configuran las cuentas de los proveedores:

#### A. ElevenLabs (Agente Conversacional ConvAI)
1. Inicia sesión en [elevenlabs.io](https://elevenlabs.io).
2. **Obtener API Key:** Ve a **Profile / API Keys** y copia tu `ELEVENLABS_API_KEY`.
3. **Crear el Agente en ConvAI:**
   * Ve a **Conversational AI > Agents > Create Agent**.
   * **Nombre:** `Yeli - Dental Demo`
   * **First Message (Saludo Inicial):**
     > *"¡Hola! Gracias por comunicarte a Clínica Dental Demo. Mi nombre es Yeli, tu asistente virtual. ¿En qué te puedo ayudar hoy?"*
   * **System Prompt:**
     > *"Eres Yeli, la asistente de Clínica Dental Demo. Atiendes cordialmente a los pacientes, respondes dudas sobre servicios (limpieza, ortodoncia, extracciones) y ayudas a agendar citas de valoración."*
   * **Post-Call Webhook (Análisis de llamada):**
     * En la configuración del agente > **Webhooks**, activa el webhook post-llamada.
     * URL: `https://<URL_CLOUD_RUN_CLIENTE>/webhooks/elevenlabs` (o tu URL de túnel local para pruebas).
     * Copia el secreto de firma generado (`ELEVENLABS_WEBHOOK_SECRET`).
   * **Copia el Agent ID:** Se encuentra en la URL o encabezado del agente (`ELEVENLABS_AGENT_ID`, ej. `agent_...`).

---

#### B. Telnyx (Telefonía y Número DID)
1. Inicia sesión en [telnyx.com](https://telnyx.com) (requiere recargar $5 - $10 USD de saldo para números y minutos).
2. **Comprar Número Telefónico (DID):**
   * Ve a **Numbers > Search & Buy Numbers**.
   * Selecciona un número local (ej. México `+52...` o USA `+1...`).
3. **Configurar Conexión SIP Trunking (Hacia ElevenLabs):**
   * Ve a **Voice > SIP Trunking / SIP Connections > Add SIP Connection**.
   * Nombre: `ElevenLabs-DentalDemo`
   * Asigna el número telefónico comprado a esta conexión SIP.
   * Copia el ID de la conexión (`TELNYX_SIP_CONNECTION_ID`).
4. **Obtener Credenciales de Telnyx:**
   * **API Key:** Ve a **Account Settings > Keys & Credentials** y crea una `TELNYX_API_KEY`.
   * **Public Key Ed25519:** En la sección de Webhooks, copia la clave pública (`TELNYX_PUBLIC_KEY`).
   * **Teléfono E.164:** Copia el número asignado (`TELNYX_PHONE_NUMBER`, ej. `+522218300450`).

---

#### C. Inyectar Credenciales de Voz en `env-vars-demo-den.yaml`
Abre el archivo `env-vars-demo-den.yaml` generado por el script en tu laptop y añade las credenciales de voz:

```yaml
# =============================================================================
# CREDENCIALES ELEVENLABS AGENTS (CONVAI)
# =============================================================================
DEFAULT_VOICE_PROVIDER: "elevenlabs"
ELEVENLABS_API_KEY: "sk_..."
ELEVENLABS_AGENT_ID: "agent_..."
ELEVENLABS_WEBHOOK_SECRET: "wsec_..."

# =============================================================================
# CREDENCIALES TELNYX TELEPHONY
# =============================================================================
TELNYX_API_KEY: "KEY..."
TELNYX_PUBLIC_KEY: "PtJ..."
TELNYX_PHONE_NUMBER: "+522218300450"
TELNYX_SIP_CONNECTION_ID: "30162..."

# =============================================================================
# RESEND & NOTIFICACIONES (OPCIONAL)
# =============================================================================
RESEND_API_KEY: "re_..."
RESEND_FROM_EMAIL: "Clínica Dental Demo <citas@ia.datagol.net>"
```

---

### 2.4 Desplegar en Google Cloud Run con Multicuenta
Con las credenciales de voz ya incorporadas en `env-vars-demo-den.yaml`:

1. **Configurar el perfil de GCP del cliente (usando sus $500 USD de crédito):**
   ```bash
   ./scripts/gcp-profile-manager.sh create demo-dental demo-dental-prod us-central1
   ```
2. **Ejecutar el despliegue:**
   ```bash
   ./scripts/deploy-client.sh demo-dental env-vars-demo-den.yaml
   ```
   * El script compilará y desplegará en Cloud Run, devolviéndote la URL activa (ej. `https://demo-dental-api-xyz.a.run.app`).

---

## 🤝 PASO 3: Verificación Final y Prueba de Voz en Vivo

### 3.1 Revisar el avance en el iPad
1. Regresa al navegador de tu **iPad** a la pestaña del portal público `/status/[STATUS_TOKEN]`.
2. Recarga la página: verás que las tareas de **Infraestructura desplegada**, **Licencia emitida**, **Cuentas de proveedores** y **Agente configurado** están completadas ✅.

### 3.2 Probar el Acceso SSO de Superadmin
1. En `app.datagol.net/admin/control`, busca el despliegue `demo-dental`.
2. Pulsa en **"Entrar como Superadmin"**.
3. El plano de control emitirá tu pasaporte JWT firmado y te abrirá la consola `/admin` del cliente demo sin requerir que crees usuario ni contraseña en su base de datos.

### 3.3 Realizar la Llamada de Prueba en Vivo 📞
1. Toma tu teléfono móvil y marca al número asignado de Telnyx (`+52...`).
2. **Verificación en llamada:**
   * El agente contesta en menos de 2 segundos.
   * Escucharás el saludo inicial de Yeli: *"¡Hola! Gracias por comunicarte a Clínica Dental Demo..."*.
   * Dile: *"Hola, quisiera informes sobre una limpieza dental"*.
   * El agente responderá de forma fluida y natural.
3. **Verificación post-llamada:**
   * Cuelga la llamada.
   * En menos de 10 segundos, ElevenLabs enviará el webhook al backend del cliente.
   * Entra al dashboard (`https://app.dentalvalle.com` o desde tu consola de Superadmin) y verás la llamada registrada en **Historial de Llamadas** con su transcripción, análisis de sentimiento y resumen ejecutivo.

---

## 🎯 Resumen del Flujo de Éxito
1. **iPad:** Cliente creado y contrato firmado digitalmente con OTP.
2. **Laptop (WSL2):** Base de datos inicializada en segundos (`provision-client.ts`).
3. **ElevenLabs & Telnyx:** Agente y número telefónico vinculados.
4. **Cloud Run:** Backend desplegado con crédito promocional de $500 USD del cliente.
5. **Prueba Real:** Llamada telefónica atendida por IA y registrada en el CRM.

