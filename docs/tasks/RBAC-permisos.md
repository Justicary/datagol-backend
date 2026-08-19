# TASK — RBAC, invitaciones y permisos configurables

**Proyecto:** `datagol-backend`
**Precondición:** la migración `45_RBAC_permisos.sql` ya está aplicada.
**Referencia obligatoria:** `AGENTS.md` de este repositorio

---

## Contexto

`organization_members.role` existía desde el inicio pero ninguna política lo consultaba: cualquier miembro tenía acceso completo, incluida la capacidad de modificar el plan de su propia organización. La migración corrige eso y agrega permisos configurables por el superadmin.

**Esta tarea toca autorización.** Un error aquí no produce un bug visible, produce un acceso indebido silencioso. Los umbrales de mutación de `AGENTS.md` §10 para seguridad y aislamiento (≥90% sobre score **total**) aplican a todo lo que se escriba.

---

## FASE A — Módulos de constraint

Patrón de `secret-keys.ts`, con prueba de inserción contra la base real:

- **`organization_members.role`**: `owner`, `admin`, `member`, `viewer`
- **`permissions.key`**: los 15 del catálogo
- **`permissions.category`**: `datos`, `operacion`, `finanzas`, `configuracion`, `usuarios`
- **`permission_audit_log.action`**: `granted`, `revoked`, `expired`, `role_changed`, `user_invited`, `user_removed`

Cero literales fuera de estos módulos.

---

## FASE B — Resolución y aplicación

### B.1 Servicio de permisos

Envuelve `auth_permissions_in_org(org_id)` con caché en memoria (TTL corto) e invalidación explícita al cambiar un rol o un override. **Una sola llamada por petición**, nunca una consulta por permiso.

### B.2 Plugin de Fastify

Decora `request.permissions` tras resolver el tenant. Helper `requirePermission(key)` que rechace con 403 y un mensaje accionable que el frontend pueda mostrar tal cual.

### B.3 ⚠️ El punto crítico: `service_role`

Toda la protección de la migración vive en RLS, y **`service_role` hace bypass de RLS**. Cada consulta que el backend haga con `supabaseAdmin` debe verificar el permiso explícitamente en código.

Esto ya era cierto para el aislamiento por tenant. Ahora también lo es para los permisos. Audita todas las rutas: si una usa `supabaseAdmin` y no llama a `requirePermission`, es un agujero.

### B.4 Restricción por columna: transcripciones

RLS protege filas, no columnas. `view_transcripts` **no puede aplicarse con RLS** y debe resolverse en la capa de API: si el usuario no tiene el permiso, `transcript` y `summary` se omiten de la respuesta antes de serializar.

Aplica a: detalle de conversación, línea de tiempo del contacto, exportaciones y resultados de reportes en lenguaje natural.

Prueba dedicada: un `viewer` que consulta una conversación recibe la respuesta **sin** el campo, no con el campo vacío. Un campo presente y nulo filtra su existencia.

### B.5 Permisos en rutas existentes

| Permiso | Rutas |
|---|---|
| `view_costs` | métricas de consumo, conciliación |
| `view_revenue` | resultado de negocio, ticket promedio |
| `use_nl_reports` | `/reports/ask` |
| `close_deals` | cambio de pipeline a `ganado` con monto |
| `configure_agent` | ajustes de agente, prompt, base de conocimiento |
| `manage_credentials` | todo `/secrets`, `/llm`, credenciales de proveedores |
| `export_data` | exportaciones |
| `erase_contact_data` | borrado ARCO |
| `change_plan` | cambio de plan |

---

## FASE C — Invitaciones

```
POST   /organizations/:id/invitations        -- crear
GET    /organizations/:id/invitations        -- listar pendientes
DELETE /organizations/:id/invitations/:invId -- revocar
POST   /invitations/accept                   -- aceptar (sin sesión de la org)
GET    /organizations/:id/members            -- listar
PATCH  /organizations/:id/members/:memberId  -- cambiar rol
DELETE /organizations/:id/members/:memberId  -- desactivar
```

### Reglas duras

- El token se genera en el servidor, se guarda **hasheado**, y viaja únicamente en el correo. Nunca en la respuesta de la API.
- Vigencia de 7 días, un solo uso.
- **No se puede invitar como `owner`.** La transferencia de propiedad es un flujo aparte, con confirmación del owner actual.
- **Un `admin` no puede modificar al `owner` ni promover a nadie a `owner`.** Verificar en código: no basta con el permiso.
- **Nadie puede modificar su propio rol.** Ni el owner.
- **Nunca puede quedar una organización sin owner.** Al desactivar o degradar al último owner, rechazar.
- Aceptar una invitación con correo distinto al invitado: rechazar.
- Toda operación escribe en `permission_audit_log`, en la misma transacción. Si el registro falla, la operación se revierte.

### Asientos

El trigger de la base ya impide exceder el límite. El backend debe:

- Devolver un mensaje accionable que indique el límite y el plan que lo amplía, no un error de constraint crudo.
- Exponer asientos usados y disponibles.
- **Bloquear el downgrade de plan** si la organización excede el límite del plan destino. Nunca expulsar usuarios automáticamente: que el admin decida a quién quitar.

---

## FASE D — Consola del superadmin

```
GET   /admin/permissions                                    -- catálogo
GET   /admin/organizations/:id/permissions                  -- mapa efectivo
PATCH /admin/organizations/:id/permissions                  -- override
GET   /admin/organizations/:id/permissions/audit            -- bitácora
```

- Solo `is_platform_admin()`. El nivel `support` es de solo lectura.
- `reason` obligatorio en todo override. `expires_at` opcional.
- **Invariante:** el `owner` nunca pierde `manage_users` ni `change_plan`. La función de base ya lo garantiza; la API debe rechazar el intento con un mensaje claro en vez de aceptarlo silenciosamente y que no tenga efecto.
- Los permisos con `is_sensitive` requieren una confirmación adicional en el payload — evita el clic accidental que abre credenciales a un `viewer`.
- Toda modificación invalida la caché de permisos de esa organización.

---

## FASE E — Migración de datos

Ejecutar y reportar antes de considerar cerrada la tarea:

1. Confirmar que **toda organización tiene al menos un owner**. Si alguna no, asignarlo antes de que RLS entre en vigor o queda inoperable.
2. Revisar organizaciones que excedan el límite de asientos de su plan actual. Reportarlas; no expulsar a nadie.

---

## Pruebas

- **La central:** un `viewer` que consulta una conversación no recibe el campo `transcript`
- Un `member` recibe 403 al consultar costos
- Un `member` recibe 403 al usar reportes en lenguaje natural
- Un `admin` recibe 403 al gestionar credenciales
- Un `admin` no puede modificar al `owner` ni promover a `owner`
- Nadie puede modificar su propio rol
- Desactivar al último owner se rechaza
- Invitar al exceder asientos devuelve mensaje accionable con el límite
- Las invitaciones pendientes cuentan contra el límite
- Downgrade con exceso de usuarios se bloquea
- Un override del superadmin cambia el permiso efectivo; al expirar, vuelve al default
- Revocar `manage_users` al owner se rechaza
- Token de invitación no aparece en ninguna respuesta de API
- Toda operación deja registro; si la bitácora falla, la operación se revierte
- Cada rechazo con su contraparte de éxito

Al terminar: `pnpm stryker run` sobre el servicio de permisos y las rutas de usuarios. Umbral ≥90% sobre score **total**, no covered.