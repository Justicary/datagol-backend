# TASK — Endpoint público de perfil de organización (Fase 8.1, LFPDPPP)

**Proyecto:** `datagol-backend` (Fastify + Node + Supabase)
**Referencia obligatoria:** `AGENTS.md` de este repositorio.
**Contraparte:** `datagol-frontend`, Fase 8.1 de `docs/tasks/frontend-implementation.md` — página pública `/privacy/[orgId]` que muestra el aviso de privacidad LFPDPPP de cada organización a los clientes finales de esa PyME (no a usuarios del dashboard). El frontend no tiene `service_role` y la RLS de `organizations` exige membresía (`org_self_access`), así que un visitante no autenticado no puede leer `name`/`email`/`address` de ninguna forma hoy. Este endpoint es la única vía.

---

## Objetivo

Un endpoint **deliberadamente sin autenticación**, que devuelve exactamente 5 columnas de `organizations` — las que ya son, por naturaleza, información pública de negocio (nombre, correo y dirección de la PyME), no datos sensibles. Nada más de esta tabla debe salir por esta ruta.

## Decisión de diseño ya tomada

**Whitelist explícita de columnas, nunca `select('*')`.** `organizations` tiene columnas de credenciales en claro (`elevenlabs_api_key`, `telnyx_api_key`, `whatsapp_access_token`, `cal_api_key`) y de estado interno (`webhook_token`, `status`, `suspended_reason`). Un `select('*')` en una ruta sin auth sería la fuga de credenciales más grave posible en este proyecto. La consulta debe nombrar cada columna: `name, email, address, city, state`.

## Endpoint

### `GET /api/organizations/:id/public-profile`

Sin `preHandler` de autenticación — a diferencia de todo lo demás en `organization.ts`, esta ruta es intencionalmente pública. Déjalo explícito en un comentario para que nadie la "arregle" agregándole auth después sin revisar por qué existe.

```ts
fastify.get<{ Params: { id: string } }>(
    '/api/organizations/:id/public-profile',
    async (request, reply) => {
        const { id } = request.params;

        const { data, error } = await supabaseAdmin
            .from('organizations')
            .select('name, email, address, city, state')
            .eq('id', id)
            .maybeSingle();

        if (error || !data) {
            return reply.status(404).send({ error: 'NotFound', message: 'Organización no encontrada.' });
        }

        return reply.send({ data });
    }
);
```

Respuesta 200:
```ts
{ data: { name: string; email: string | null; address: string | null; city: string | null; state: string | null } }
```

Respuesta 404 si el `id` no existe — no reveles si es un UUID inválido vs. una organización borrada, mismo mensaje para ambos casos.

Agregar el registro de esta ruta dentro de `organizationRoutes` en `src/routes/organization.ts` (ya se registra en `app.ts`, no hace falta un plugin nuevo).

---

## Pruebas obligatorias

- `GET /api/organizations/:id/public-profile` sin ningún header de autenticación → 200 (confirma que es pública a propósito, no un descuido).
- La respuesta **nunca** incluye `elevenlabs_api_key`, `telnyx_api_key`, `whatsapp_access_token`, `cal_api_key`, `webhook_token`, `status`, `suspended_reason`, ni ninguna otra columna fuera de la whitelist — test explícito sobre las claves del JSON de respuesta (`Object.keys(data)`), no solo sobre los valores esperados.
- `id` inexistente → 404.

---

## Qué NO hacer

- No usar `select('*')` ni `select('*, algo_mas')` — la whitelist de columnas es todo el control de seguridad de esta ruta.
- No agregarle un `preHandler` de autenticación "por si acaso" — es pública por diseño, documentar por qué en el propio archivo.
- No exponer `phone_number` — no forma parte del aviso de privacidad y no fue pedido.
