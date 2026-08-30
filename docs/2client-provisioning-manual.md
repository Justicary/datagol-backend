# Manual de Aprovisionamiento e Inicialización de Nuevos Clientes (DFY / SaaS)

**Documento hermano de:** [`docs/control-plane-tech-manual.md`](control-plane-tech-manual.md) y [`docs/admin-passport-sso-tech-manual.md`](admin-passport-sso-tech-manual.md).

Este manual define el procedimiento operativo y arquitectónico para inicializar y desplegar la infraestructura de un nuevo cliente bajo el modelo **Done-For-You (DFY)** y listo para escalar hacia un modelo **SaaS multi-inquilino**, garantizando el aislamiento estricto de datos y la automatización sin errores.

---

## 1. Propósito y Modelo Arquitectónico

Datagol opera bajo dos capas independientes:
1. **Plano de Control Central (`api.datagol.net`):**
   * Gestiona el registro comercial (`customers`), contratos con firma electrónica (`contracts`), emisión de licencias criptográficas (`licenses`), catálogo de tareas de onboarding (`provisioning_tasks`) y monitoreo de la flota (`v_fleet_health`).
2. **Instalación Operativa del Cliente (`api.cliente.com`):**
   * Ejecuta el backend de Fastify con la lógica de negocio, CRM (`contacts`), citas (`appointments`), llamadas telefónicas (`call_logs`), integraciones (ElevenLabs, Telnyx, Meta) y el cliente de licencias (`license_client_state`).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        api.datagol.net (PLANO DE CONTROL)              │
│                                                                        │
│ 1. ALTA COMERCIAL       2. CONTRATO DIGITAL       3. EMISIÓN LICENCIA  │
│    POST /control/          POST /control/            POST /control/    │
│    customers               contracts/sign            licenses          │
│    deployments             (OTP verificado)          (Firma Ed25519)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Genera: License JWT + DEPLOYMENT_ID
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   INSTALACIÓN CLIENTE (ej. clinica.com)                │
│                                                                        │
│ 4. BASE DE DATOS              5. BACKEND                     6. FRONTEND│
│    Supabase aislado           Cloud Run / Docker             Next.js   │
│    • Esquema Operativo        • CONTROL_PLANE=false          • UI      │
│    • Fila en organizations    • LICENSE_PUBLIC_KEYS          • SSO Sup │
│    • license_client_state     • ADMIN_PASSPORT_PUBLIC_KEYS             │
│                               • DEPLOYMENT_ID / URL plano              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Matriz de Aislamiento de Esquema

| Componente / Tabla | Plano de Control (`api.datagol.net`) | Cliente Operativo (`api.cliente.com`) |
|---|---|---|
| `customers`, `deployments`, `contracts` | ✅ **Exclusivo** (Migraciones `55`, `69`) | ❌ **Prohibido** |
| `licenses`, `license_heartbeats` | ✅ **Exclusivo** (Migración `55`) | ❌ **Prohibido** |
| `provisioning_tasks`, `deployment_events` | ✅ **Exclusivo** (Migraciones `55`, `71`) | ❌ **Prohibido** |
| `license_client_state` | ✅ Solo estado local | ✅ **Obligatorio** (Singleton `id=true`) |
| `organizations`, `contacts`, `leads` | ✅ Para Datagol | ✅ **Obligatorio** (Datos del cliente) |
| `call_logs`, `appointments`, `catalogs` | ✅ Para Datagol | ✅ **Obligatorio** (Operación del cliente) |
| `plans`, `features`, `permissions` | ✅ Catálogo global | ✅ **Catálogo local** |

---

## 3. DDL Maestro Operativo (`db/client-schema-bootstrap.sql`)

El archivo [`db/client-schema-bootstrap.sql`](../db/client-schema-bootstrap.sql) es el script SQL consolidado e **idempotente** para crear la base de datos de un cliente nuevo en un solo paso.

### Características del DDL Maestro:
* **100% Idempotente:** Utiliza cláusulas `CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS` y bloques `DO $$ ...` para poder aplicarse de forma segura sobre bases nuevas o existentes.
* **Libre del Plano de Control:** Excluye las migraciones `55`, `69` y `71`.
* **Semillas Incluidas:** Precarga los planes estándar (`starter`, `pro`, `enterprise`), las features del sistema, la matriz de permisos RBAC y la fila inicial de `license_client_state`.

---

## 4. Servicio y CLI de Aprovisionamiento

Para automatizar la ejecución sin errores humanos, se dispone de dos interfaces:

### 4.1 Módulo de Servicio TypeScript (`src/services/client-provisioning-service.ts`)
Invocable programáticamente desde endpoints o jobs de `pg-boss`:

```typescript
import { provisionNewClientDeployment } from './services/client-provisioning-service.js';

const result = await provisionNewClientDeployment({
    deploymentId: '8f7d9342-6e21-4f1b-8e12-3456789abcde',
    organizationName: 'Clínica Dental Norte',
    organizationEmail: 'contacto@dentalnorte.com',
    planKey: 'pro',
    targetDatabaseUrl: 'postgresql://postgres:PASSWORD@db.cliente.supabase.co:5432/postgres',
    targetSupabaseUrl: 'https://cliente.supabase.co',
    targetSupabaseSecretKey: 'sb_secret_...',
});
```

### 4.2 CLI Automatizado (`scripts/provision-client.ts`)
Ejecutable por operadores desde la terminal:

```bash
npx tsx scripts/provision-client.ts \
  --deployment-id="8f7d9342-6e21-4f1b-8e12-3456789abcde" \
  --org-name="Clínica Dental Norte" \
  --org-email="contacto@dentalnorte.com" \
  --db-url="postgresql://postgres:PASSWORD@db.cliente.supabase.co:5432/postgres" \
  --supabase-url="https://cliente.supabase.co" \
  --supabase-key="sb_secret_..." \
  --plan-key="pro"
```

---

## 5. Pipeline Automatizado de Activación Post-Firma

Cuando el cliente firma el contrato digital a través de `/control/deployments/:id/contract/verify-otp`:

```mermaid
sequenceDiagram
    autonumber
    actor Cliente
    participant CP as api.datagol.net
    participant DB_Cli as Supabase Cliente
    participant CR_Cli as Cloud Run Cliente

    Cliente->>CP: Firma Contrato con OTP
    CP->>CP: Valida OTP y emite Licencia JWT (Ed25519)
    CP->>DB_Cli: Aplica client-schema-bootstrap.sql
    CP->>DB_Cli: Inserta Organization y Credential Group
    CP->>DB_Cli: Siembra license_client_state con JWT
    CP->>CR_Cli: Desplaza Contenedor con variables del cliente
    CP->>CP: Actualiza tareas de provisión (100% completas)
    CP-->>Cliente: Redirige a portal de estatus activo
```

---

## 6. Configuración de Variables de Entorno del Cliente

El aprovisionador genera automáticamente el archivo `env-vars-[slug].yaml` para Cloud Run:

```yaml
# =============================================================================
# VARIABLES DE ENTORNO — INSTALACIÓN CLIENTE
# =============================================================================
CONTROL_PLANE: "false"
DEPLOYMENT_ID: "8f7d9342-6e21-4f1b-8e12-3456789abcde"
CONTROL_PLANE_URL: "https://api.datagol.net"
ADMIN_SESSION_SECRET: "c8f93...64_caracteres_aleatorios..."

# Llaves públicas para verificación local y SSO de Superadmin
LICENSE_PUBLIC_KEYS: "{\"v1\":\"-----BEGIN PUBLIC KEY-----\\n...\"}"
ADMIN_PASSPORT_PUBLIC_KEYS: "{\"v1\":\"-----BEGIN PUBLIC KEY-----\\n...\"}"

# Base de datos Supabase aislada del Cliente
SUPABASE_URL: "https://cliente.supabase.co"
SUPABASE_SECRET_KEY: "sb_secret_..."
SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..."
DATABASE_URL: "postgresql://postgres:PASSWORD@db.cliente.supabase.co:5432/postgres"

# Credenciales de Proveedores del Cliente (BYOK)
DEFAULT_VOICE_PROVIDER: "elevenlabs"
PORT: "8080"
HOST: "0.0.0.0"
```

---

## 7. Verificación Post-Despliegue y Pruebas de Humo (Smoke Tests)

Una vez desplegada la instancia del cliente (`https://api.cliente.com`):

### 1. Health Check
```bash
curl -i https://api.cliente.com/health
# Esperado: {"status":"ok"}
```

### 2. Aislamiento Estricto del Plano de Control
```bash
curl -i https://api.cliente.com/control/customers
# Esperado: 404 Not Found (Garantiza que CONTROL_PLANE=false desactiva rutas padre)
```

### 3. Verificación de Estado de Licencia Local
```bash
curl -i https://api.cliente.com/ready
# Esperado: {"status":"ready", "database":"connected", "license":"active"}
```

### 4. Acceso SSO del Superadmin
Desde la consola central `app.datagol.net`, el operador selecciona el despliegue del cliente y entra a `/admin` mediante el pasaporte firmado sin requerir credenciales locales en la base del cliente.
