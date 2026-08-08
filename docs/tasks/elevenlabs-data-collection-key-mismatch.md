# TASK — Alinear `call-payload-mapper.ts` con las claves reales de `data_collection_results` del agente y verificar el onboarding del webhook (Fase 2 — post-llamada de ElevenLabs)

**Proyecto:** `datagol-backend` (Fastify + Node + Supabase).
**Referencia obligatoria:** `AGENTS.md` de este repositorio y `docs/tasks/backend-implementation.md` §2 (webhook de post-llamada de ElevenLabs, ya implementado).
**Contraparte:** `datagol-frontend`. El widget de demo de la landing (`WebCallModal` → `HeroSection.tsx`) llama al mismo agente de ElevenLabs (`agent_0801kyr7h69hehdv6bgz7enntv9h`, organización `56422ca1-ec44-45b4-9eac-7e068d9169be` — la organización DFY única de este despliegue) que atenderá las llamadas telefónicas reales. El widget es solo una demostración del canal de voz de ElevenLabs; el pipeline de post-llamada (extracción de datos del prospecto, creación de lead) debe ser el mismo para ambos, y ya vive enteramente aquí — no en el frontend.

---

## Contexto (verificado, no hipótesis)

El usuario hizo una llamada de prueba desde el widget de la landing. En el dashboard de ElevenLabs (pestaña **Analysis → Data collection** de esa conversación) el agente **sí extrajo correctamente** los datos del prospecto — nombre completo, teléfono, correo, motivo de consulta — con confianza alta y valores correctos. ElevenLabs ya cobró el análisis. El problema es 100% nuestro, no de ElevenLabs, y tiene dos causas independientes que hay que resolver ambas:

### Causa 1 — Desalineación de claves entre el agente real y el código (la que rompe la extracción incluso si el webhook llega)

`src/services/call-payload-mapper.ts` define `DATA_COLLECTION_KEYS` con estos nombres, y `__tests__/call-payload-mapper.test.ts` los prueba con esos mismos nombres:

```ts
const DATA_COLLECTION_KEYS = {
    fullName: 'nombre_completo',
    contactPhone: 'telefono_contacto',
    email: 'email',
    inquiryReason: 'motivo_consulta',
    bookedAppointment: 'agendo_cita',
    // ... businessName, businessSector, temperature, needsFollowup, followupNotes, callVolume
} as const;
```

Pero el agente configurado **hoy** en el dashboard de ElevenLabs (Agent → Analysis → Data Collection) usa estos nombres, confirmados en la captura de la conversación real:

| Campo mostrado en ElevenLabs (real) | Clave esperada hoy por el código | ¿Coincide? |
|---|---|---|
| `nombre_completo_prospecto` | `nombre_completo` | ❌ |
| `telefono_contacto_prospecto` | `telefono_contacto` | ❌ |
| `correo_electronico_prospecto` | `email` | ❌ |
| `motivo_consulta` | `motivo_consulta` | ✅ |
| `cita_programada` (boolean) | `agendo_cita` | ❌ |

`extractString`/`extractRawValue` en `call-payload-mapper.ts` devuelven `null` en silencio cuando la clave no existe en `results` (es la regla de "honestidad de datos" del propio archivo: nunca inferir). Ese diseño es correcto — el bug es que las claves configuradas no son las que el código busca, así que **4 de 5 campos capturados por ElevenLabs se descartan silenciosamente** aunque el webhook llegue y se procese sin errores.

El agente tampoco tiene configurados (y está bien que no los tenga todavía — no es parte de este bug) `nombre_negocio`, `giro_negocio`, `temperatura`, `requiere_seguimiento`, `notas_seguimiento`, `volumen_llamadas`: esos quedarán `null`, es el comportamiento esperado hasta que se decida capturarlos.

### Causa 2 — Falta verificar que el webhook de esta organización esté realmente dado de alta

`src/routes/webhooks/elevenlabs.ts` resuelve la organización por `organizations.webhook_token` en la URL y luego verifica la firma HMAC contra `organization_secrets` (clave `webhook_signing_secret`, `src/types/secret-keys.ts`). Si cualquiera de los dos falta, el webhook responde 401 y `process_call_completed` nunca se ejecuta — la llamada de prueba del usuario podría no haber llegado nunca a este backend, independientemente de la Causa 1.

No asumas el estado actual: verifícalo contra la base real antes de dar esto por bueno.

---

## Qué implementar

### 1. Corregir `DATA_COLLECTION_KEYS` en `src/services/call-payload-mapper.ts`

Actualizar los valores al nombre real configurado en el agente:

```ts
const DATA_COLLECTION_KEYS = {
    fullName: 'nombre_completo_prospecto',
    contactPhone: 'telefono_contacto_prospecto',
    email: 'correo_electronico_prospecto',
    inquiryReason: 'motivo_consulta',
    bookedAppointment: 'cita_programada',
    // businessName, businessSector, temperature, needsFollowup, followupNotes,
    // callVolume: sin cambio — el agente aún no las captura, no hay evidencia
    // de qué nombre tendrían. No inventes valores para ellas.
    businessName: 'nombre_negocio',
    businessSector: 'giro_negocio',
    temperature: 'temperatura',
    needsFollowup: 'requiere_seguimiento',
    followupNotes: 'notas_seguimiento',
    callVolume: 'volumen_llamadas',
} as const;
```

No es necesario tocar `extractString`/`extractRawValue`/`extractBoolean`/`extractTemperature` ni la firma de `MappedCallData` — el bug es solo el diccionario de nombres, no la lógica de extracción.

Actualiza `__tests__/call-payload-mapper.test.ts` (el fixture `dataCollectionResults` del test "mapea todas las claves...") para usar los nombres reales — hoy prueba `nombre_completo`, `telefono_contacto`, `agendo_cita`, que ya no existen en el agente real y quedarían probando un contrato obsoleto.

**Nota para consistencia futura (no bloqueante, no lo hagas como parte de esta tarea):** si en el futuro se renombran los campos de Data Collection en el dashboard de ElevenLabs para que coincidan con el código original, hay que volver a sincronizar este diccionario en la dirección contraria. La fuente de verdad la tiene el agente configurado en ElevenLabs, no este archivo — documenta ese acoplamiento en el comentario que ya existe arriba de `DATA_COLLECTION_KEYS` si lo tocas.

### 2. Verificar (y de ser necesario, dar de alta) el onboarding del webhook para la organización `56422ca1-ec44-45b4-9eac-7e068d9169be`

Con `scripts/provision-org-secrets.ts`:

```bash
# 1. Verificar si ya existen (no los regeneres si ya están — romperías la firma
#    del lado de ElevenLabs si no actualizas ambos lados a la vez).
#    Revisa organizations.webhook_token y organization_secrets (Vault) para
#    esta organización directamente en Supabase antes de generar nada.

# 2. Si falta webhook_token:
pnpm tsx scripts/provision-org-secrets.ts webhook-token --org 56422ca1-ec44-45b4-9eac-7e068d9169be --generate

# 3. Si falta webhook_signing_secret:
pnpm tsx scripts/provision-org-secrets.ts secret --org 56422ca1-ec44-45b4-9eac-7e068d9169be --key webhook_signing_secret --generate
```

Luego, **fuera de código**, en el dashboard de ElevenLabs del agente `agent_0801kyr7h69hehdv6bgz7enntv9h` (Settings → Webhooks, o a nivel workspace según la versión del dashboard):
- Configurar el webhook `post_call_transcription` apuntando a `POST https://<host-público-del-backend>/webhooks/elevenlabs/<webhook_token>` (el `webhook_token` recién generado o el existente).
- Pegar exactamente el mismo valor de `webhook_signing_secret` que quedó en `organization_secrets` como el secreto de firma HMAC del webhook en ElevenLabs — **ambos lados deben tener el valor idéntico**, sin importar cuál se generó primero. Si ElevenLabs solo permite que sea autogenerado por ellos, copia ESE valor hacia `organization_secrets` en vez de generar uno nuevo aquí (usa el subcomando `secret --key webhook_signing_secret --value <el-valor-de-elevenlabs>`, sin `--generate`).

Esto es responsabilidad de quien tenga acceso al dashboard de ElevenLabs de esta organización — si no tienes ese acceso, deja el paso 1 (código) completo y reporta explícitamente que el paso 2 (dashboard) queda pendiente y de quién depende, no lo des por hecho.

### 3. No hace falta tocar nada más de la persistencia

`process_call_completed` (`db/migrations/03_process_call_completed.sql`) ya hace `UPSERT` de `call_logs` por `provider_call_id` con `COALESCE` (nunca pisa un dato bueno con uno vacío) y `INSERT ... ON CONFLICT (organization_id, conversation_id) DO NOTHING` en `leads`. Esto es importante porque `datagol-frontend` **ya inserta** una fila de `call_logs` inmediatamente al colgar (vía su propio RPC `log_public_call`, sin datos de contacto — ver `docs/sql/log_public_call_rpc.sql` de ese repo) para reflejo inmediato en el dashboard de demo. Cuando el webhook llegue después con el análisis completo, el `UPSERT` va a **enriquecer esa misma fila** (mismo `provider_call_id` = `conversation_id`), no crear un duplicado ni fallar por la restricción única. No cambies ese comportamiento ni el RPC — ya está diseñado para esta coexistencia.

`leads.channel = 'voice'` está hardcodeado en el RPC para toda conversación de ElevenLabs, incluida la del widget web — es intencional (es una conversación de voz transportada por navegador, no un formulario), no lo cambies a `'web'`.

---

## Pruebas obligatorias

- `__tests__/call-payload-mapper.test.ts`: actualizar el fixture existente a las claves reales; el test debe seguir verificando que los 5 campos capturados por el agente (`fullName`, `contactPhone`, `email`, `inquiryReason`, `bookedAppointment`) se mapean correctamente, y que los campos no configurados en el agente (`businessName`, `temperature`, etc.) devuelven `null`/`false` sin lanzar.
- Añadir un caso con `data_collection_results` como en la captura real (solo los 5 campos presentes, sin `nombre_negocio`/`giro_negocio`/etc.) para cubrir exactamente el payload de producción, no solo el fixture completo.
- `__tests__/webhooks-elevenlabs.test.ts` y `__tests__/process-call-completed-rpc.test.ts` no deberían requerir cambios — no tocan `DATA_COLLECTION_KEYS` — pero corre la suite completa (`pnpm test`) para confirmarlo.

## Qué NO hacer

- No modifiques `verifyElevenLabsSignature`, el orden de operaciones de `src/routes/webhooks/elevenlabs.ts`, ni `process_call_completed` — nada de eso está roto, el bug es únicamente el diccionario de nombres de campo.
- No inventes nombres de clave para `businessName`/`businessSector`/`temperature`/`needsFollowup`/`followupNotes`/`callVolume` — no hay evidencia de qué nombre tendrían si se configuraran; déjalos como están (`nombre_negocio`, `giro_negocio`, etc., ya siguen la convención observada) y que quede explícito en el PR que son especulativos hasta que se configuren en el agente.
- No cambies `leads.channel` a `'web'` para las llamadas del widget de demo.
- No generes un nuevo `webhook_signing_secret` si ya existe uno para esta organización sin antes confirmar (con quien tenga acceso al dashboard de ElevenLabs) que también se va a actualizar del lado de ElevenLabs — un secreto desincronizado entre ambos lados deja el webhook rechazando todo con 401 de forma indistinguible de "no configurado".
