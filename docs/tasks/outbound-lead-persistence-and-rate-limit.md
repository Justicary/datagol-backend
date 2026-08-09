# TASK — Persistir datos del formulario en llamadas outbound + límite de tasa en `/api/voice/outbound`

**Proyecto:** `datagol-backend` (Fastify + Node + Supabase).
**Referencia obligatoria:** `AGENTS.md`, `docs/tasks/elevenlabs-data-collection-key-mismatch.md` (ya implementada — mismo `process_call_completed` que esta tarea vuelve a tocar).
**Contraparte:** `datagol-frontend`. `LeadForm.tsx` (landing) → `POST /api/outbound/demo` (Next.js) → `POST /api/voice/outbound` (aquí). El frontend **ya** manda `X-Forwarded-For` con la IP real del visitante en ese proxy servidor-a-servidor, y ya aplica su propio límite de tasa (3/hora por IP, 2/día por número) como primera línea de defensa — este documento es el límite autoritativo, porque `/api/voice/outbound` no tiene `preHandler` de auth y es alcanzable directo (curl, otro cliente), sin pasar por el frontend.

Dos problemas distintos, un mismo punto de entrada. Impleméntalos juntos porque el segundo depende del primero (ver Orden de implementación).

---

## Problema 1 — Los datos del formulario nunca llegan a `leads`/`contacts`

Verificado contra una llamada outbound real (`+522225102025`, `conv_9301kzhqqynzfvfa6hb2br7me3cz`): `leads.full_name`, `email`, `business_name`, `business_sector` quedaron en `null` a pesar de que el formulario web los tenía todos. Solo `contact_phone`/`phone_e164` (del tramo telefónico real) e `inquiry_reason` (que el agente sí volvió a preguntar en voz) se persistieron.

Causa raíz, dos capas:

1. **`src/routes/voice.ts`, `handleVoiceOutbound`** ni siquiera lee `body.customerEmail` ni un campo de giro/industria — solo construye `{ organizationId, customerPhone, customerName, companyName, demoObjective, customVariables }`. El correo y el giro se pierden antes de llegar a ElevenLabs. El frontend ya manda `customerEmail` e `industry` en el body (verificado en `datagol-frontend/src/app/api/outbound/demo/route.ts`).
2. **Aunque se reenviaran:** `ElevenLabsAdapter.triggerOutboundCall` solo los mete en `conversation_initiation_client_data.dynamic_variables` — eso sirve para que el agente los mencione al hablar (`{{customer_name}}`), pero **no alimenta `analysis.data_collection_results`**. `leads`/`contacts` solo se llenan hoy vía el webhook `post_call_transcription`, que depende de que el agente vuelva a preguntar/confirmar esos datos en voz durante la llamada. Para una llamada outbound eso no tiene sentido: el negocio ya tiene esos datos, confiables, tecleados por la persona.

### Fix

**1.1 — `voice-provider.interface.ts`:** extender `OutboundCallParams` con `customerEmail?: string` y `businessSector?: string`.

**1.2 — `voice.ts`, `handleVoiceOutbound`:** leer `body.customerEmail` y `body.industry` del request, pasarlos en el objeto que se manda a `triggerOutboundCall`.

**1.3 — Sembrar `contacts`/`call_logs`/`leads` en cuanto ElevenLabs confirma el `conversation_id`, no esperar al webhook.** Inmediatamente después de que `provider.triggerOutboundCall(...)` resuelve con éxito en `handleVoiceOutbound` (tienes ahí `fastify.supabaseAdmin` y el `organizationId` — hazlo a nivel de ruta, no dentro del adapter, que debe quedar limitado a hablar con la API de ElevenLabs), llama al RPC `process_call_completed` con los datos confiables del formulario:

```ts
const normalized = normalizePhoneE164(phone); // src/services/phone-normalization.ts, ya existe

await fastify.supabaseAdmin.rpc('process_call_completed', {
  p_organization_id: organizationId,
  p_conversation_id: result.callId,
  p_provider_call_id: result.callId,
  p_caller_phone_e164: normalized.success ? normalized.phoneE164 : null,
  p_full_name: customerName,
  p_email: customerEmail ?? null,
  p_business_name: companyName ?? null,
  p_business_sector: industry ?? null,
  p_contact_phone_raw: phone,
  p_inquiry_reason: demoObjective ?? null,
  p_temperature: null,
  p_booked_appointment: false,
  p_needs_followup: false,
  p_followup_notes: null,
  p_call_volume: null,
  p_transcript: null,
  p_summary: null,
  p_duration_seconds: 0,
  p_usage_entries: [],
});
```

No dejes que un error de esta llamada tumbe la respuesta al frontend (la llamada real de ElevenLabs ya se disparó y cuesta dinero de cualquier forma) — regístralo con `request.log.error` y sigue devolviendo el resultado de `triggerOutboundCall` normalmente. Cuando el webhook real llegue minutos después con el mismo `conversation_id`, va a fusionarse sobre esta siembra (ver 1.4).

**1.4 — `ElevenLabsAdapter.triggerOutboundCall`: nunca inventar un `conversation_id`.** Hoy tiene `callId: (data.conversation_id as string) || (data.call_id as string) || 'el_' + Date.now()`. Ese último fallback es el problema: si ElevenLabs no devuelve un ID real, sembrarías (1.3) y el webhook real llegaría con OTRO `conversation_id` — quedarían dos registros huérfanos sin fusionarse nunca, silenciosamente. Cambia el fallback por un `throw` explícito ("ElevenLabs no devolvió conversation_id ni call_id en la respuesta de outbound-call") para que el error sea visible en vez de generar datos corruptos.

**1.5 — Migración nueva:** `process_call_completed` (`db/migrations/05_process_call_completed_usage.sql`, firma vigente de 19 parámetros) hace `INSERT ... ON CONFLICT (organization_id, conversation_id) DO NOTHING` en `leads`. Con la siembra de 1.3, eso significa que si el webhook real llega después con `temperature`/`booked_appointment`/`needs_followup` capturados en vivo, **se descartan silenciosamente** porque el conflicto no actualiza nada. Cambia ese paso a `DO UPDATE` con el mismo patrón `COALESCE` que ya usan `contacts` y `call_logs` en la misma función:

```sql
ON CONFLICT (organization_id, conversation_id) DO UPDATE SET
    full_name = COALESCE(public.leads.full_name, EXCLUDED.full_name),
    email = COALESCE(public.leads.email, EXCLUDED.email),
    business_name = COALESCE(public.leads.business_name, EXCLUDED.business_name),
    business_sector = COALESCE(public.leads.business_sector, EXCLUDED.business_sector),
    inquiry_reason = COALESCE(public.leads.inquiry_reason, EXCLUDED.inquiry_reason),
    temperature = COALESCE(public.leads.temperature, EXCLUDED.temperature),
    booked_appointment = public.leads.booked_appointment OR EXCLUDED.booked_appointment,
    needs_followup = public.leads.needs_followup OR EXCLUDED.needs_followup,
    followup_notes = COALESCE(public.leads.followup_notes, EXCLUDED.followup_notes),
    call_volume = COALESCE(public.leads.call_volume, EXCLUDED.call_volume)
RETURNING id INTO v_lead_id;

IF v_lead_id IS NULL THEN
    SELECT id INTO v_lead_id FROM public.leads
    WHERE organization_id = p_organization_id AND conversation_id = p_conversation_id;
END IF;
v_lead_inserted := true; -- con DO UPDATE, RETURNING siempre da id; ajusta v_lead_inserted
                          -- solo si de verdad necesitas distinguir insert vs update en el jsonb de retorno
```

Como la lista de parámetros no cambia (sigue siendo la firma de 19 de la migración 05), un `CREATE OR REPLACE FUNCTION` con el mismo encabezado basta — no hace falta el `DROP FUNCTION` que sí fue necesario al pasar de 18 a 19 parámetros en la migración 05. Revisa `v_lead_inserted`/`lead_inserted` en el `jsonb_build_object` final: con `DO UPDATE`, `RETURNING id INTO v_lead_id` ya no viene `NULL` en un conflicto, así que la rama `IF v_lead_id IS NOT NULL` de detección de insert-vs-update dejó de servir tal cual — decide tú la forma más limpia de preservar esa distinción si algún consumidor de `lead_inserted` la necesita (revisa `process-call-completed.ts` y sus tests antes de asumir que no importa).

---

## Problema 2 — Sin límite de tasa, `/api/voice/outbound` es un vector de abuso

Cualquiera puede pegarle a `/api/voice/outbound` (o sus alias `/api/vapi/outbound`, `/api/vapi/call`) con **cualquier número de teléfono** — no solo agota los minutos contratados en ElevenLabs, se puede usar para marcarle repetidamente a un tercero sin su consentimiento. No hay `preHandler`, no hay ninguna librería de rate limiting instalada en el proyecto (verificado: `@fastify/rate-limit` no está en `package.json`), y las columnas `organizations.max_call_duration_seconds`/`max_concurrent_calls`/`silence_timeout_seconds` existen en el schema pero no se usan en ningún lado del código — no hay ni siquiera un tope de duración por llamada individual. Esta tarea no las activa (alcance separado); solo agrega el límite de intentos.

Política acordada con el usuario: **3 llamadas/hora por IP de origen, 2 llamadas/día al mismo número marcado**, contando también los intentos que fallan (no solo los que conectan) — un atacante no debe poder reintentar sin límite solo porque un intento anterior fue rechazado.

### Fix

**2.1 — Tabla nueva** (migración `06_outbound_call_rate_limit.sql` o el siguiente número disponible):

```sql
CREATE TABLE IF NOT EXISTS public.outbound_call_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid REFERENCES public.organizations(id),
    target_phone_raw text NOT NULL,
    source_ip text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_call_attempts_phone_created_idx
    ON public.outbound_call_attempts (target_phone_raw, created_at);
CREATE INDEX IF NOT EXISTS outbound_call_attempts_ip_created_idx
    ON public.outbound_call_attempts (source_ip, created_at);
```

Tabla de solo lectura/inserción (log de intentos), no reutilices `call_logs` — conceptualmente son cosas distintas (un intento no siempre produce una llamada real) y no quieres acoplar el conteo de abuso a una tabla de negocio con sus propias restricciones únicas.

**2.2 — En `handleVoiceOutbound` (`voice.ts`), antes de llamar a `provider.triggerOutboundCall`:**

1. Normaliza el teléfono destino (`normalizePhoneE164`) para la clave de conteo — usa el E.164 si se pudo normalizar, si no el crudo tal cual llegó.
2. Lee la IP de origen: `request.headers['x-forwarded-for']` (el frontend ya la manda ahí; si llega vacío, usa `request.ip` de Fastify como respaldo — así también protege a quien golpee esta ruta directo, sin pasar por el frontend).
3. Cuenta contra `outbound_call_attempts`:
   - `WHERE target_phone_raw = <normalizado> AND created_at > now() - interval '24 hours'` — si `>= 2`, responde `429` con `{ status: 'error', message: 'Este número ya alcanzó el límite de llamadas permitidas hoy.' }`.
   - `WHERE source_ip = <ip> AND created_at > now() - interval '1 hour'` — si `>= 3`, responde `429` con `{ status: 'error', message: 'Demasiadas solicitudes de llamada desde este origen.' }`.
4. Si ambos límites pasan, **inserta la fila de intento primero** (antes de llamar al proveedor) y luego procede con `triggerOutboundCall` normalmente. No hace falta bloqueo/transacción especial para la condición de carrera entre dos requests casi simultáneos — el costo de un falso negativo ocasional aquí es bajo, no es una ruta financiera crítica.

No apliques este límite a `/api/voice/agent` ni `/api/voice/metrics` — son de solo lectura, no cuestan dinero ni marcan a nadie.

---

## Orden de implementación

Haz el Problema 2 (rate limit) **antes o junto con** el Problema 1, no después. La siembra inmediata de `leads` en 1.3 crea un registro por cada intento aceptado — sin el límite de tasa ya activo, cada llamada de abuso generaría un lead falso de inmediato en vez de solo cuando el webhook procesara una llamada completada, empeorando la contaminación de métricas que esta misma sesión de trabajo identificó como problema aparte.

## Pruebas obligatorias

- `call-payload-mapper.test.ts` y los tests existentes de `process-call-completed-rpc.test.ts` no deberían necesitar cambios de comportamiento salvo por el nuevo `ON CONFLICT DO UPDATE` de `leads` — agrega un caso: sembrar un lead vía `process_call_completed` con solo datos de formulario (temperature/booked_appointment ausentes), luego volver a llamarlo simulando el webhook real con `temperature='caliente'` y `booked_appointment=true` para el mismo `conversation_id` — verifica que el segundo `UPDATE` sí sobrescribe esos dos campos (a diferencia de `full_name`/`email`, que deben quedarse con el valor del primer insert vía `COALESCE`).
- Test nuevo para `ElevenLabsAdapter.triggerOutboundCall`: si la respuesta de ElevenLabs no trae `conversation_id` ni `call_id`, debe lanzar, no generar un ID sintético.
- Test nuevo para el rate limit de `/api/voice/outbound`: 3ª solicitud en la misma hora desde la misma IP → 429; 2ª a un número distinto de esa misma IP debe pasar si no excede el límite por IP; 3ª solicitud al mismo número (aunque sea desde IPs distintas) dentro de 24h → 429.

## Qué NO hacer

- No actives `max_call_duration_seconds`/`max_concurrent_calls`/`silence_timeout_seconds` como parte de esta tarea — es un tope de duración por llamada individual, un problema relacionado pero distinto (rate limiting es "cuántas llamadas", esto es "cuánto dura cada una"). Repórtalo como deuda técnica identificada si quieres, no lo implementes aquí sin que te lo pidan explícitamente.
- No muevas la llamada a `process_call_completed` de 1.3 dentro de `ElevenLabsAdapter` — el adapter debe seguir limitado a hablar con la API de ElevenLabs; la persistencia va en la ruta, que ya tiene `fastify.supabaseAdmin`.
- No confíes en `request.ip` de Fastify como única fuente de IP — el frontend ya manda `X-Forwarded-For` con la IP real del visitante en las llamadas que vienen de la landing; úsala cuando esté presente.
