# Playbook de Implementación en 3 Fases: Nuevos Clientes (DFY / Multicuenta GCP)

Este documento es la **guía operativa paso a paso** para cerrar, aprovisionar y desplegar nuevos clientes de Datagol utilizando el modelo *Done-For-You* (DFY) y aprovechando las promociones de crédito de Google Cloud ($500 USD de crédito inicial en la cuenta del cliente).

---

## Resumen Ejecutivo del Flujo

```
┌────────────────────────────────────────────────────────────────────────┐
│ FASE 1: ONBOARDING Y FIRMA (En Tablet / iPad o Laptop)                 │
│ • Alta del cliente en https://app.datagol.net/admin/control            │
│ • Firma digital de contrato con código OTP (en el iPad o smartphone)   │
│ • El cliente recibe su enlace público de seguimiento /status/:token    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ FASE 2: PROVISIÓN Y MULTICUENTA GCP (En tu Laptop con WSL2)            │
│ • Crear perfil GCP del cliente: ./scripts/gcp-profile-manager.sh       │
│ • Aprovisionar DB y Licencia:  npx tsx scripts/provision-client.ts    │
│ • Desplegar en Cloud Run:      ./scripts/deploy-client.sh <slug>       │
│ • Conectar Frontend en Vercel con la URL generada                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ FASE 3: ENTREGA Y VERIFICACIÓN (En el equipo del cliente / Remoto)     │
│ • El cliente inicia sesión en su portal web (app.cliente.com)          │
│ • Entras con tu Pasaporte SSO de Superadmin a /admin                   │
│ • Configuración de telefonía y llamada de prueba en vivo               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Fase 1: Venta, Onboarding y Firma Digital (Tablet / iPad)

> **Herramienta:** Navegador web en Tablet (iPad) o Laptop personal.  
> **Tiempo estimado:** 5 a 10 minutos.

1. **Acceso al Plano de Control:**
   * Entra a `https://app.datagol.net/admin/control` con tus credenciales de Superadmin.
2. **Registro del Cliente (`customers`):**
   * Pulsa **"Nuevo Onboarding"** o **"Crear Cliente"**.
   * Llena los datos comerciales y fiscales:
     * Razón Social / Nombre Comercial.
     * RFC y Régimen Fiscal.
     * Nombre del contacto, correo electrónico y teléfono móvil.
3. **Creación del Despliegue (`deployments`):**
   * Selecciona el plan contratado (`starter`, `pro`, `enterprise`).
   * Asigna el slug único de identificación (ej. `dental-valle`).
   * Fija el costo de setup y la mensualidad recurrente en MXN/USD.
4. **Firma Electrónica con OTP:**
   * El sistema genera el contrato digital y envía un código OTP de 6 dígitos al correo del firmante.
   * El cliente abre su correo (en su teléfono o en el iPad), ingresa el código OTP y pulsa **"Firmar Contrato"**.
5. **Entrega de la Página de Estatus:**
   * El cliente recibe su enlace público de seguimiento: `https://app.datagol.net/status/[STATUS_TOKEN]`.
   * En esta página verá en tiempo real el avance de su infraestructura (0% → 50% → 100%).

---

## Fase 2: Provisión y Despliegue Multicuenta (Tu Laptop con WSL2)

> **Herramienta:** Terminal WSL2 en tu laptop con los scripts de Datagol.  
> **Tiempo estimado:** 5 minutos.

### Paso 2.1: Gestión de la Cuenta GCP del Cliente (Créditos de $500 USD)
Para no mezclar cuentas y que el cliente consuma sus $500 USD promocionales:

1. Ejecuta el gestor de perfiles:
   ```bash
   ./scripts/gcp-profile-manager.sh
   ```
2. Selecciona **Opción 3 (Crear nuevo perfil)**:
   * **Nombre del perfil:** `dental-valle`
   * **ID del Proyecto GCP:** `dental-valle-prod`
   * **Región:** `us-central1`
3. Se abrirá el navegador para autenticar la cuenta de Google del cliente (o tu cuenta si te otorgaron permisos de *Editor/Owner* vía IAM).

---

### Paso 2.2: Inicialización de Base de Datos y Emisión de Licencia
Ejecuta el script de aprovisionamiento automatizado:

```bash
npx tsx scripts/provision-client.ts \
  --deployment-id="<UUID_DEL_DESPLIEGUE>" \
  --org-name="Clínica Dental del Valle" \
  --org-email="contacto@dentalvalle.com" \
  --db-url="postgresql://postgres:PASSWORD@db.xxx.supabase.co:5432/postgres" \
  --supabase-url="https://xxx.supabase.co" \
  --supabase-key="sb_secret_xxx" \
  --plan-key="pro"
```

**Lo que hace el script en segundos:**
* Ejecuta `db/client-schema-bootstrap.sql` en el Supabase del cliente.
* Inserta la organización y crea su grupo de credenciales.
* Emite la licencia comercial Ed25519 desde el Plano de Control.
* Siembra `license_client_state` en la base del cliente.
* Actualiza las tareas en el plano de control (`infra_desplegada: completada`).
* Genera el archivo `env-vars-dental-valle.yaml`.

---

### Paso 2.3: Despliegue del Backend en Cloud Run
Con el perfil de GCP del cliente activo, ejecuta:

```bash
./scripts/deploy-client.sh dental-valle env-vars-dental-valle.yaml
```

**Lo que hace el script:**
* Compila la imagen Docker en Cloud Build usando los créditos de GCP del cliente.
* Despliega en Cloud Run con `min-instances=1`, CPU *Always Allocated* y puerto `8080`.
* Realiza el health-check y devuelve la URL final (ej. `https://dental-valle-api-xyz.a.run.app`).

---

### Paso 2.4: Conexión del Frontend
1. En Vercel o en el hosting del frontend, añade las variables de entorno del cliente:
   * `NEXT_PUBLIC_API_URL=https://dental-valle-api-xyz.a.run.app`
   * `NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co`
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxx`
2. Asigna el dominio del cliente (ej. `https://app.dentalvalle.com`).

---

## Fase 3: Entrega, Verificación y Activación en Vivo

> **Herramienta:** Navegador web en el equipo del cliente o en videollamada.  
> **Tiempo estimado:** 10 minutos.

1. **Creación del Usuario Inicial del Cliente:**
   * El cliente entra a `https://app.dentalvalle.com` y se registra con su correo corporativo.
   * El sistema lo asigna como `owner` de su organización.
2. **Acceso de Soporte con Pasaporte SSO de Superadmin:**
   * **Nunca le pidas su contraseña al cliente.**
   * Desde `app.datagol.net/admin/control`, seleccionas el despliegue de `dental-valle` y pulsas **"Entrar como Superadmin"**.
   * El plano de control genera un pasaporte firmado con `ADMIN_PASSPORT_SIGNING_KEYS` y te autentica en el `/admin` del cliente al instante.
3. **Carga de Configuración Inicial (BYOK):**
   * Configuras las credenciales de telefonía (Telnyx/Twilio) y el agente de ElevenLabs ConvAI.
   * Cargas el catálogo inicial de servicios y horarios en Cal.com.
4. **Llamada de Prueba en Vivo:**
   * Marcas al número asignado del cliente.
   * El agente contesta en menos de 2 segundos, agenda una cita y la minuta llega por correo en tiempo real.
5. **Cierre de Onboarding:**
   * La página `/status/:token` marca el **100% de avance** y pasa a estatus **Activo**.

---

## Checklist de Seguridad y Buenas Prácticas

- [ ] **Propiedad Intelectual:** Nunca clonar ni descargar el repositorio de código fuente en la máquina del cliente.
- [ ] **Aislamiento Multi-Cuenta:** Verificar con `gcloud config configurations list` qué perfil de GCP está activo antes de desplegar.
- [ ] **Fail-Fast de Licencia:** Asegurar que `license_client_state` tenga el JWT sembrado antes de entregar el servicio.
- [ ] **Latencia de Producción:** Confirmar que Cloud Run del cliente esté desplegado con `min-instances=1` para eliminar *cold starts* en llamadas de voz.
