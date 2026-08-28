# Manual Técnico — Pasaporte de Superadmin (SSO delegado a api.datagol.net)

Documento hermano de [`docs/control-plane-tech-manual.md`](control-plane-tech-manual.md) (arquitectura del plano de
control) y de [`docs/tasks/control-plane-backend-datagol.md`](tasks/control-plane-backend-datagol.md). Este manual
cubre un mecanismo distinto que reutiliza la misma infraestructura de firma: cómo el operador de Datagol entra a
`/admin` en **cualquier** instalación cliente con su identidad de `api.datagol.net`, sin depender de que esa
instalación comparta proyecto Supabase con el plano de control.

Toda la implementación descrita aquí está construida y verificada de punta a punta en dos repositorios
(`datagol-backend`, `mi-new-app`), con la suite completa de ambos en verde.

---

## 1. El problema que resuelve

`/admin` (consola de superadmin: organizaciones, features, planes, factory-reset, conciliación, permisos RBAC) se
protege hoy con `isPlatformAdmin()` → RPC `is_platform_admin()` → tabla `platform_admins`, evaluada **localmente
contra el proyecto Supabase de esa instalación**.

Eso funciona para el operador solo por una coincidencia de infraestructura: la mayoría de las instalaciones cliente
comparten el mismo proyecto Supabase que usa `api.datagol.net` (modelo híbrido, AGENTS.md §5). Para un cliente con
proyecto Supabase **aislado** (el otro caso del mismo modelo), el operador no está reconocido ahí — tendría que
haberse aprovisionado a mano de antemano en esa base específica. No existía ningún mecanismo real que validara la
identidad de superadmin contra `api.datagol.net`.

---

## 2. Diseño: un pase firmado, verificado localmente sin red

Mismo patrón que la licencia (Ed25519 vía `jose`, verificación local, sin llamada de red en el momento de uso) —
pero con **llaves y alcance completamente separados** de los de licenciamiento: comprometer la llave de licencias
no debe dar acceso admin, y viceversa.

```
Operador en app.datagol.net (ya autenticado, is_platform_admin()=true ahí)
        │  1. Elige un despliegue en /admin/sso/authorize (dropdown de /control/fleet)
        │  POST /control/admin-passport { deploymentId }
        ▼
api.datagol.net (datagol-backend, CONTROL_PLANE=true)
  - Exige isPlatformAdmin (guard ya existente de /api/admin/**)
  - Resuelve `deployments` por deploymentId (tabla del plano de control, Fase C)
  - Firma JWT corto (5 min): { sub, email, aud: deploymentId, jti, iss:'api.datagol.net', exp }
  - Log en deployment_events (event_type 'pase_admin_emitido')
        │  redirect → https://[cliente].com/admin/sso/callback?passport=<jwt>
        ▼
Frontend del CLIENTE (mi-new-app, esa instalación)
  /admin/sso/callback (Route Handler)
        │  POST a SU PROPIO backend: /api/admin/sso/exchange { passport }
        ▼
Backend del CLIENTE (datagol-backend, esa instalación)
  - Verifica firma con ADMIN_PASSPORT_PUBLIC_KEYS (sin red)
  - Verifica aud === env.DEPLOYMENT_ID (identidad de ESTA instalación)
  - Verifica jti no usado antes (de un solo uso)
  - Mint de una sesión LOCAL (1h), firmada con ADMIN_SESSION_SECRET
    (HS256 simétrico, propio de esta instalación, nunca sale de ella)
        │  { sessionToken }
        ▼
Route Handler pone cookie HttpOnly `datagol_admin_session` → redirect a /admin
```

`AdminLayout` (frontend) y `isPlatformAdmin` (backend, `lib/platform-admin.ts`) aceptan **cualquiera** de dos
caminos independientes: el RPC local existente (sigue funcionando exactamente igual donde ya funciona) **o** la
sesión derivada del pase. Ninguno reemplaza al otro.

---

## 3. Por qué dos JWT distintos, no uno

| | Pase (`lib/admin-passport.ts`) | Sesión local (`lib/admin-session.ts`) |
|---|---|---|
| Quién firma | Solo `api.datagol.net` | Cada instalación, a sí misma |
| Algoritmo | Ed25519 (asimétrico) | HS256 (simétrico) |
| Por qué | Cruza de una instalación a otra — necesita verificarse sin compartir secretos | Se firma y se verifica en el mismo proceso; no necesita viajar a ningún otro lado |
| Vigencia | 5 minutos, un solo uso (`jti`) | 1 hora, reutilizable dentro de su vigencia |
| Dónde vive la llave privada | Exclusiva de `api.datagol.net` (`ADMIN_PASSPORT_SIGNING_KEYS`) | `ADMIN_SESSION_SECRET`, propio y distinto por instalación, nunca sale de ahí |

Usar un solo JWT de larga vida para todo el flujo habría significado o bien (a) que el pase de 5 minutos sea
también la sesión de trabajo de una hora — obligando a repetir el flujo completo de redirect cada 5 minutos — o
(b) alargar la vigencia del pase, ampliando la ventana en la que una URL filtrada (logs, proxies, historial del
navegador) sirve para algo. Separar ambos JWT deja cada uno con la vigencia mínima que su propósito exige.

---

## 4. Endpoints

### 4.1 Emisión — exclusivo de `api.datagol.net` (`CONTROL_PLANE=true`)

`POST /control/admin-passport` (`src/routes/control/admin-passport.ts`) — bajo `isPlatformAdmin`, igual que el
resto de `/control/**`.

- Body: `{ deploymentId: uuid }`.
- Rechaza con 400 si el llamador no tiene un correo real detrás (el atajo local `x-platform-admin: true` no puede
  emitir un pase — no hay a quién auditar).
- Resuelve `deployments.install_url`; sin esa URL, 400 (no hay a dónde redirigir).
- Responde `{ data: { callbackUrl, deploymentSlug, expiresAt } }` — `callbackUrl` ya trae el pase incrustado,
  listo para redirigir el navegador.
- Dos filas de auditoría por cada emisión: el pase en sí (`jti` firmado) y un registro en `deployment_events`
  (`event_type: 'pase_admin_emitido'`, migración 71) con el correo del operador.

### 4.2 Canje — en TODA instalación

`POST /api/admin/sso/exchange` (`src/routes/admin/sso.ts`) — **sin** `isPlatformAdmin`: es precisamente el
mecanismo para obtenerlo; su propia autorización es la firma verificable del pase.

- Body: `{ passport: string }`.
- 500 claro si esta instalación no tiene `DEPLOYMENT_ID` o `ADMIN_SESSION_SECRET` configurados — no puede aceptar
  pases sin ambos.
- 401 genérico ("inválido, expirado, ya usado, o emitido para otro despliegue") si `verifyAdminPassport` rechaza
  el pase por cualquier motivo — deliberadamente sin distinguir cuál, para no regalarle información a quien esté
  probando pases ajenos.
- Éxito → `{ data: { sessionToken, expiresAt } }`.

`GET /api/admin/sso/whoami` — protegido por el `isPlatformAdmin` ya actualizado; 200 con el correo si la sesión
(local o de Supabase) es válida. Es el chequeo liviano que usa `AdminLayout` para no reverificar el JWT dentro del
proceso de Next.js (`ADMIN_SESSION_SECRET` nunca vive ahí).

---

## 5. Seguridad: qué impide que esto sea una puerta trasera

- **`aud` = `deploymentId` real, no un dominio en texto.** Un pase emitido para el despliegue A se verifica con
  `audience: env.DEPLOYMENT_ID` en el despliegue B — si no coincide, `jwtVerify` lanza y el intercambio se
  rechaza. Probado explícitamente (`__tests__/admin-passport.test.ts`, "PRUEBA CENTRAL").
- **Un solo uso — con una limitación real que hay que conocer.** `jti` se rastrea en memoria (`usedJti` en
  `lib/admin-passport.ts`, mismo criterio que `lib/rate-limiter.ts`); un segundo intento con el mismo pase —
  aunque la firma siga siendo válida — se rechaza. Mitiga que la URL haya quedado en un log, un proxy, o el
  historial del navegador. **Pero el `Map` es local a un solo proceso**, no se comparte entre réplicas: si el
  backend de una instalación cliente corre con más de una instancia (a diferencia del camino de voz, nada en este
  diseño exige `min-instances=1` aquí), un interceptor que gane la carrera contra una réplica *distinta* a la que
  atendió el canje legítimo podría canjear el mismo pase una segunda vez. La vigencia de 5 minutos acota la
  ventana, pero no la cierra del todo — si `/api/admin/sso/exchange` alguna vez corre detrás de un balanceador
  con más de una instancia, esto necesita moverse a un almacén compartido (ej. una fila `UNIQUE` en Postgres) en
  vez de memoria del proceso.
- **Vigencia de 5 minutos.** Aunque el `jti` no se rastreara, la ventana de explotación de una URL filtrada es
  mínima.
- **La sesión local nunca cruza instalaciones.** `ADMIN_SESSION_SECRET` es un secreto simétrico propio de cada
  instalación — un atacante con la sesión local de la instalación A no puede usarla contra la instalación B, ni
  siquiera si de alguna forma obtuviera el secreto (HS256 no comparte estructura entre instalaciones distintas,
  cada una firma con el suyo).
- **La emisión exige un correo real.** El atajo de desarrollo `x-platform-admin: true` (sin usuario real de
  Supabase Auth detrás) no puede emitir un pase — sin correo no hay a quién auditar en `deployment_events`.
- **El mensaje de rechazo del canje es deliberadamente genérico.** Firma inválida, `aud` equivocado, expirado y
  `jti` reutilizado responden el mismo 401 — distinguirlos filtraría información útil para quien esté probando
  pases ajenos.

---

## 6. Variables de entorno nuevas

| Variable | Dónde | Notas |
|---|---|---|
| `ADMIN_PASSPORT_SIGNING_KEYS` | Solo `api.datagol.net` | JSON `{ key_version: pem_privada }`. Ed25519, separada de `CONTROL_PLANE_SIGNING_KEYS`. |
| `ADMIN_PASSPORT_PUBLIC_KEYS` | Toda instalación | JSON `{ key_version: pem_pública }`. Sin ella, `verifyAdminPassport` siempre falla — el canje nunca funciona, pero el arranque no se ve afectado. |
| `ADMIN_SESSION_SECRET` | Toda instalación, valor **distinto** por instalación | Secreto simétrico HS256. Sin él, `/api/admin/sso/exchange` responde 500 (no crítico — no es una ruta de voz). |
| `DEPLOYMENT_ID` | Toda instalación cliente | `deployments.id` del plano de control. Es el `aud` que un pase debe traer para ser válido ahí. **Instalaciones ya desplegadas necesitan que se les fije a mano** — no llega solo. |

Ninguna de las cuatro es fail-fast al arranque (a diferencia de `CONTROL_PLANE_SIGNING_KEYS`) — su ausencia
simplemente significa que el pase de superadmin no funciona en esa instalación todavía; nunca bloquea el arranque
ni afecta la atención de voz/WhatsApp/agendamiento.

**De dónde sale el valor de `ADMIN_PASSPORT_PUBLIC_KEYS`:** el par Ed25519 no lo genera cada instalación — lo
genera `api.datagol.net` una sola vez (mismo mecanismo que las llaves de licencia, ver
`docs/control-plane-tech-manual.md` §3), y la mitad **pública** de ese mismo par se distribuye a cada instalación
cliente al aprovisionarla. No existe todavía un paso automatizado que la entregue — es un valor que se copia a
mano al desplegar (o se agrega a mano en instalaciones ya existentes), igual que `DEPLOYMENT_ID`. Rotar la llave
significa: generar un nuevo par, publicar la nueva entrada pública en `ADMIN_PASSPORT_PUBLIC_KEYS` de **todas**
las instalaciones activas antes de que `api.datagol.net` empiece a firmar con ella (mismo orden que la rotación de
licencia), y solo entonces retirar la llave privada anterior.

---

## 7. Frontend (`mi-new-app`)

- `src/lib/auth/admin-sso-session.ts` — `verifyAdminSsoSession()`: lee la cookie, la valida contra `whoami` del
  backend de esa misma instalación. Usado por `AdminLayout` para el gate.
- `src/lib/auth/admin-access-token.ts` — `resolveAdminAccessToken()`: qué token pasarle a los paneles cliente
  (`accessToken` prop) una vez que el gate ya se pasó — prioriza la cookie SSO, si no existe cae a la sesión de
  Supabase de siempre. Reemplazó la resolución de sesión duplicada en 6 páginas (`organizations`,
  `organizations/[orgId]`, `reconciliation`, `features`, `plans`, `factory-reset`).
- `src/app/admin/sso/callback/route.ts` — Route Handler que canjea el pase y pone la cookie.
- `src/app/admin/sso/authorize/page.tsx` + `AdminSsoAuthorizePanel` — selector de instalación destino contra
  `/control/fleet`. Solo produce resultados en la instalación de referencia `datagol`; en cualquier otra
  instalación cliente, `/control/fleet` no existe (Fase F del plano de control) y la página simplemente muestra
  el error que el backend devuelva. Se envía en el bundle de **todas** las instalaciones (Next.js no tiene forma
  de excluir una ruta del build por cliente sin una bandera de compilación dedicada, y esta tarea no introduce
  una) — es código muerto e inofensivo en cualquier instalación que no sea la de referencia, mismo criterio que
  ya se aplica a `/control/**` del lado del backend: la ruta puede *existir* en el bundle sin que eso implique que
  *funcione* en runtime.

### Límite conocido, sin resolver

La consola de permisos RBAC (`AdminPermissionsConsole`, bajo `/admin/organizations/[orgId]/permissions`) obtiene
su JWT **client-side**, directo de `createSupabaseBrowserClient()`, en vez de recibirlo como prop desde un server
component. Una cookie HttpOnly es, por diseño, invisible para JavaScript del navegador — este componente no puede
leer `datagol_admin_session` aunque quisiera. Resultado: el pase de superadmin abre el gate de `/admin` y funciona
en las otras 6 páginas, pero esta consola específica sigue exigiendo una sesión real de Supabase Auth en esa
instalación. Convertirla al mismo patrón server-component-pasa-token-como-prop que las demás páginas es la forma
natural de cerrar este hueco — no se hizo en esta entrega porque son varios puntos de re-fetch de sesión dentro
del mismo componente cliente, no un cambio de una línea.

---

## 8. Pruebas

**`datagol-backend`:** `__tests__/admin-passport.test.ts` (firma/verificación, `aud` cruzado entre despliegues —
prueba central, `jti` reutilizado, llave de otra versión, expirado), `__tests__/admin-session.test.ts` (sesión
local, secreto equivocado, issuer equivocado, `ADMIN_SESSION_SECRET` ausente), `__tests__/control-admin-passport-route.test.ts`
(emisión, auditoría en `deployment_events`, correo real obligatorio), `__tests__/admin-sso-routes.test.ts`
(canje, `aud` cruzado a nivel de ruta, reuso rechazado, `whoami`).

**`mi-new-app`:** `__tests__/admin-sso-session.test.ts`, `__tests__/admin-access-token.test.ts`,
`__tests__/admin-sso-callback-route.test.ts`.

`stryker.config.json` (backend) incluye `lib/admin-passport.ts`, `lib/admin-session.ts`, `lib/signing-keys.ts`,
`lib/platform-admin.ts`, `routes/control/admin-passport.ts` y `routes/admin/sso.ts` en `mutate` — se verifican
manualmente en ≥90% (categoría "seguridad y aislamiento", AGENTS.md §10) mientras `thresholds.break` siga en
`null` para el resto del proyecto.
