# Manual Técnico — Jev (TypeSafe AI) vía OpenRouter

Jev es el modelo "System One" de TypeSafe AI: no redacta texto, **responde
preguntas tipadas sobre un estado** y devuelve probabilidades que el código
consume directamente. En Datagol se usa como juez rápido y barato para
clasificar, detectar y puntuar — el código decide qué hacer con la
respuesta.

> Código calcula. Jev juzga. El LLM redacta.

Este manual cubre la configuración por organización, el contrato de la API,
cómo usarlo desde código, el metering y las reglas de uso. Documento hermano
de [`db/schema.md`](../db/schema.md) y de
[`natural-language-reports.md`](natural-language-reports.md).

---

## 1. Modelo de cuenta: BYOK por organización, aparte del LLM

Cada organización aporta **su propia cuenta de OpenRouter** para Jev. La
llave y la configuración viven **separadas** del LLM BYOK
(`llm_api_key` / `integration_settings.llm`):

| | LLM BYOK | Jev |
|---|---|---|
| Para qué | Redactar (reportes semanales, narrativas, traducción NL) | Juzgar (probabilidad, opción, escala) |
| Llave en `organization_secrets` | `llm_api_key` | `jev_api_key` |
| Configuración | `integration_settings.llm` `{provider, model, baseUrl, …}` | `integration_settings.jev` `{model, validatedAt, lastError}` |
| Proveedor | Anthropic / OpenAI / Google / OpenRouter | Siempre OpenRouter (origen fijo `https://openrouter.ai`) |
| `usage_events.provider` | `llm` | `jev` |

**Por qué separadas:** Jev no redacta. Si una organización lo pusiera como
su único modelo de LLM, se romperían los reportes semanales y las narrativas.

Migraciones: [`72_jev_byok.sql`](../db/migrations/72_jev_byok.sql) (clave de
secreto) y [`73_jev_metering.sql`](../db/migrations/73_jev_metering.sql)
(proveedor de metering y tarifas 0). La 73 amplía el CHECK de
`usage_events.provider`: **antes de aplicarla**, confirmar el nombre real del
constraint como indica su encabezado.

---

## 2. Configurar una organización

Todas las rutas exigen el permiso `manage_credentials` (mismo RBAC que
`/llm-config`).

1. **Guardar la llave** (endpoint genérico de credenciales, cifrada en Vault):

   ```http
   POST /api/organizations/:id/credentials
   { "provider": "jev", "value": "<llave de OpenRouter>" }
   ```

2. **Elegir el modelo** (slug de OpenRouter `autor/modelo`; `~` = alias que
   sigue siempre a la última versión):

   ```http
   PATCH /api/organizations/:id/jev-config
   { "model": "~typesafe/jev-latest" }
   ```

   Cambiar el modelo resetea `validatedAt`/`lastError`.

3. **Validar la llave**:

   ```http
   POST /api/organizations/:id/jev/validate
   → 200 { "success": true, "data": { "validatedAt": "…" } }
   → 422 { "success": false, "kind": "invalid_key" | "no_credit" | "network_error" | "unknown" | "not_configured", "error": "<mensaje accionable>" }
   ```

   Usa `GET https://openrouter.ai/api/v1/key`: **no consume tokens** y no
   depende del formato de ninguna API de modelos. Una llave con tope de gasto
   agotado (`limit_remaining <= 0`) se reporta como `no_credit` aunque
   OpenRouter responda 200. Nunca expone el mensaje crudo del proveedor.

4. **Consultar**: `GET /api/organizations/:id/jev-config`.

5. **Prueba de humo de punta a punta** (sin desplegar, desde Node):

   ```bash
   pnpm tsx scripts/jev-smoke-test.ts --org <organization_id> [--model ~typesafe/jev-latest]
   ```

   Verifica tarifas `jev` (migración 73), guarda el modelo si falta, valida
   la llave, hace **una decisión real** con el ejemplo de §3 (noul + choice +
   score) y comprueba los asientos en `usage_events`. Consume tokens reales
   (centavos) y deja dos filas append-only a tarifa 0. Termina con código 1 en
   el primer paso que falle.

Estado "validado" (`isJevConfigValidated`): modelo configurado,
`validatedAt` no nulo y `lastError` nulo.

---

## 3. Contrato de la API de decisiones

`POST https://openrouter.ai/api/alpha/decisions` — tomado de
`@openrouter/sdk` 1.3.23 (`alpha.decisions.create`). Es una API **alpha**:
si cambia, la validación Zod de la respuesta falla ruidosamente
(`kind: 'unknown'`) en vez de propagar datos mal formados.

**Petición**

```json
{
  "model": "~typesafe/jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "Does this message convey urgency?",
                     "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } },
    "department":  { "type": "choice", "instructions": "Which team should handle this?",
                     "criteria": { "billing": "Payments…", "technical": "Bugs…", "sales": "Pricing…" } },
    "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                     "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

- `state`: texto o JSON estructurado. Preferir objetos con campos explícitos.
- Headers: `Authorization: Bearer <llave>`, `HTTP-Referer`, `X-OpenRouter-Title`.

**Respuesta**

```json
{
  "id": "…", "model": "…", "provider": "…",
  "answers": {
    "is_urgent":   { "type": "noul",   "noul": 0.93 },
    "department":  { "type": "choice", "choice": "billing", "confidence": 0.81,
                     "probabilities": { "billing": 0.88, "technical": 0.10, "sales": 0.02 } },
    "frustration": { "type": "score",  "score": 1.4, "confidence": 0.7, "probabilities": { … } }
  },
  "usage": { "input_tokens": 120, "output_tokens": 6, "cost": 0.00004 }
}
```

| Tipo | Pregunta | Respuesta | Límites |
|---|---|---|---|
| `noul` | ¿Es verdad? | `noul` ∈ [0, 1] | `criteria {true, false}` opcional |
| `choice` | ¿Cuál opción? | `choice` + `probabilities` + `confidence` | 2–255 opciones |
| `score` | ¿Dónde en la escala? | `score` (puede ser fraccionario) + `probabilities` + `confidence` | 2–10 niveles, de menor a mayor |

Las preguntas se evalúan **en paralelo e independientes**: la respuesta de una
no influye en otra. Agregar preguntas casi no suma latencia, sí tokens.

**Por qué `fetch` y no el SDK:** el SDK reintenta 5XX con backoff hasta por
una hora por defecto, lo que choca con los reintentos de pg-boss (AGENTS.md
§8), y el contrato cabe en un archivo. Sin dependencia nueva.

---

## 4. Uso desde código

Punto de entrada: `evaluateJevDecision()` en
[`src/services/jev-decision-service.ts`](../src/services/jev-decision-service.ts).

```ts
import { evaluateJevDecision } from '../services/jev-decision-service.js';
import type { JevQuestions } from '../services/jev/jev-decisions-client.js';

const questions = {
    sentimiento: {
        type: 'choice',
        instructions: '¿Cuál es el tono del cliente en esta llamada?',
        criteria: {
            positivo: 'Satisfecho, agradecido',
            neutral: 'Sin emoción marcada',
            urgente: 'Necesita atención inmediata',
            queja: 'Molesto o inconforme',
        },
    },
} as const satisfies JevQuestions;

const outcome = await evaluateJevDecision(fastify, organizationId, {
    state: { transcripcion: transcript },
    questions,
});

if (outcome.ok && (outcome.answers.sentimiento.confidence ?? 0) >= 0.7) {
    // outcome.answers.sentimiento.choice: 'positivo' | 'neutral' | 'urgente' | 'queja'
} else {
    // Camino degradado: LLM, heurística o revisión humana.
}
```

Garantías:

- **Nunca lanza.** Devuelve `{ ok: true, answers, model, usage }` o
  `{ ok: false, reason }`, con `reason` ∈ `not_configured`,
  `invalid_request` (bug del llamador: preguntas fuera de contrato, no se
  envió nada), `invalid_key`, `no_credit`, `model_not_found`,
  `network_error` (incluye 408/429/5XX/524/529: transitorio, el job decide
  si reintenta) o `unknown` (incluye respuesta fuera de contrato).
- **Respuestas tipadas por pregunta**: con `as const satisfies JevQuestions`,
  `answers.<clave>.choice` es la unión exacta de las opciones — sin castear.
- **Validadas contra lo preguntado**: cada pregunta tiene respuesta del mismo
  tipo, cada `choice` es una de sus opciones y toda probabilidad está en
  [0, 1]. Si no, `reason: 'unknown'`.
- **Timeout** propio (default 10 s, `timeoutMs` para ajustarlo).
- Errores registrados con `organizationId`; el mensaje crudo del proveedor
  solo va al log, nunca a respuestas de API.

Cliente de bajo nivel (sin configuración ni metering):
`createJevDecision()` en
[`src/services/jev/jev-decisions-client.ts`](../src/services/jev/jev-decisions-client.ts).

---

## 5. Metering

Cada decisión exitosa registra en `usage_events` (append-only):

| `provider` | `unit_type` | `quantity` | `metadata` |
|---|---|---|---|
| `jev` | `jev_input_token` | `usage.input_tokens` | `model`, `decision_id`, `questions`, `provider_cost_usd` |
| `jev` | `jev_output_token` | `usage.output_tokens` | `model`, `decision_id`, `questions` |

- Tarifa desde `provider_rates` (0 por ser BYOK: el cliente paga directo a
  OpenRouter). No hay tarifas literales en código.
- `provider_cost_usd` es el costo real que reporta OpenRouter; va solo en el
  asiento de entrada para no duplicarlo. Sirve para conciliación.
- Un fallo de metering se registra en el log pero **no invalida** la
  decisión ya obtenida.

---

## 6. Reglas de uso

- **Prohibido en `routes/tools/**`** (AGENTS.md §3): es una llamada síncrona a
  un tercero dentro del camino crítico de voz. Úsese en jobs de pg-boss y
  servicios fuera de la llamada.
- **Siempre con camino degradado**: `ok: false` es un resultado esperado
  (organización sin Jev configurado, proveedor caído).
- **La confianza controla la automatización**: confianza alta → actuar;
  media → respaldo con LLM; baja → revisión humana o pedir aclaración.
  Los umbrales viven en el código que llama, no en este servicio.
- **Calibrado no es infalible**: una probabilidad alta no garantiza que la
  respuesta sea correcta.
- **Preguntas estrechas y atómicas.** Si no se puede expresar como "dado
  este estado, dime X" con X = probabilidad, opción o escala, no es tarea
  para Jev.
- **Jev no extrae valores libres** (fechas, montos, nombres). Eso sigue en
  código determinista o en el LLM.
- Si una feature de negocio pasa a depender de Jev, debe registrarse en
  `features` y verificarse al ejecutar el job (AGENTS.md §16).

---

## 7. Casos de uso candidatos

Del análisis inicial (ninguno implementado todavía):

1. Traducción NL → intención en reportes (`nl-translation-service.ts`):
   `choice` sobre el catálogo + `requiere_aclaracion` / `no_resuelta`.
2. Sentimiento de llamadas Vapi (`process-vapi-call-completed.ts`): `choice`
   `positivo | neutral | urgente | queja` en vez de JSON libre de un LLM.
3. Respaldo de temperatura/origen del prospecto cuando ElevenLabs no los
   envía (`call-payload-mapper.ts`): `choice` sobre los valores del CHECK.
4. Alerta de prospecto caliente por umbral (`notify-hot-lead.ts`): `noul`.
5. QA de conversaciones (AGENTS.md §14): `noul` "¿el agente malinterpretó?"
   + `score` de severidad.
6. Filtrar ruido en el análisis de competidores: `choice` por línea cambiada.

---

## 8. Archivos

| Archivo | Rol |
|---|---|
| `src/services/jev/openrouter-key-client.ts` | Validación de llave (`GET /api/v1/key`), origen y headers de OpenRouter |
| `src/services/jev/jev-decisions-client.ts` | Cliente de `POST /api/alpha/decisions`, tipos y validación |
| `src/services/jev-config-service.ts` | `integration_settings.jev`, validación de credenciales |
| `src/services/jev-decision-service.ts` | `evaluateJevDecision()`: config + llave + llamada + metering |
| `src/routes/organization-jev.ts`, `src/schemas/jev.ts` | Rutas `/jev-config` y `/jev/validate` |
| `scripts/jev-smoke-test.ts` | Prueba de humo contra OpenRouter y la base real |
| `db/migrations/72_jev_byok.sql`, `73_jev_metering.sql` | `jev_api_key`, proveedor `jev`, tarifas 0 |
| `__tests__/jev-*.test.ts`, `__tests__/organization-jev-routes.test.ts` | Pruebas unitarias (sin base de datos) |

Las pruebas de sincronía con la base real
(`__tests__/secret-keys.test.ts`, `__tests__/usage-event-provider.test.ts`)
recogen `jev_api_key` y `jev` automáticamente y fallan si las migraciones 72
y 73 no están aplicadas.
