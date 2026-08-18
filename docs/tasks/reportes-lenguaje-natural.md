# TASK — Reportes en lenguaje natural (BACKEND)

**Proyecto:** `datagol-backend`
**Precondiciones:** BYOK de LLM implementado. Migración de resultado de negocio aplicada. Catálogo de intenciones acordado.
**Referencia obligatoria:** `AGENTS.md` de este repositorio

## Arquitectura — la decisión que gobierna todo

**El LLM traduce, no consulta.** Nunca escribe SQL, nunca toca la base de datos, nunca calcula.

```
Pregunta en español
      ↓  (LLM)
Intención estructurada  { intent, filtros, periodo, agrupar_por }
      ↓  (Zod)
Validación estricta
      ↓  (código humano)
Consulta parametrizada escrita y probada
      ↓
Resultado exacto
      ↓  (LLM, opcional)
Redacción de una frase de contexto
```

**Por qué así:** un modelo generando SQL contra este esquema produciría consultas válidas y semánticamente equivocadas con frecuencia. `leads` es la conversación y `contacts` la persona; `usage_events` es append-only con asientos negativos; `temperature` es null en registros antiguos. Un resultado incorrecto se ve exactamente igual que uno correcto, y nadie puede auditarlo.

Además, un LLM con conexión SQL es una vía de fuga entre tenants. Esta arquitectura la elimina por construcción.

**Prohibido**, aunque parezca más flexible: generar SQL, permitir SQL crudo desde el prompt, o exponer el esquema real al modelo.

---

## FASE A — Registro de intenciones
`src/services/reports/intents/` — un archivo por intención, con:

- Identificador y descripción en español
- Esquema Zod de sus parámetros
- La función que ejecuta la consulta parametrizada
- Ejemplos de preguntas que resuelve (alimentan el prompt de traducción)
- Forma del resultado: número, tabla, o lista

### Las 18 intenciones de la v1
**Agenda**
`listado_citas` · `conteo_citas` · `citas_por_estado` · `citas_sin_desenlace`

**Pendientes**
`pendientes_abiertos` · `seguimientos_vencidos` · `prospectos_calientes_sin_atender`

**Captación**
`conteo_prospectos_nuevos` · `listado_prospectos` · `conteo_conversaciones` · `atribucion_origen`

**Costo**
`costo_total` · `costo_por_canal` · `costo_por_prospecto` · `costo_por_cita`

**Resultado**
`resultado_negocio` · `cumplimiento_citas` · `tasa_conversion`

No agregar más en la v1. Las familias de pipeline, contenido y calidad entran en la v2, priorizadas por lo que registre la Fase F.

## FASE B — Dimensiones compartidas
Se resuelven una vez, no por intención.

**Periodo** — hoy, ayer, esta semana, semana pasada, este mes, mes pasado, últimos N días, rango explícito. **Siempre en la zona horaria de la organización** (`organizations.timezone`), nunca UTC. "Esta semana" en Puebla no es "esta semana" en el servidor.

**Canal** — del módulo de constraint de `leads.channel`.

**Agrupar por** — día, semana, mes, canal, etapa, giro, origen.

**Comparar con** — periodo anterior o mismo periodo del mes pasado. Habilita "¿mejoré?".

Pruebas dedicadas para la resolución de periodo. Es el componente que más silenciosamente puede equivocarse.

## FASE C — Traducción
`POST /organizations/:id/reports/ask` con la pregunta en texto.

El prompt recibe: el catálogo de intenciones con sus descripciones y ejemplos, la fecha actual en zona local, y la pregunta. Devuelve **únicamente JSON**.

Reglas duras del prompt:

- Elegir **una** intención del catálogo o devolver `no_resuelta`
- **Prohibido inventar intenciones o parámetros** fuera del esquema
- Si la pregunta es ambigua, devolver `requiere_aclaracion` con la pregunta de vuelta
- Nunca aproximar a la intención más cercana cuando no hay una que encaje

La respuesta se valida con Zod. Si no valida, se trata como `no_resuelta` — nunca se intenta reparar el JSON adivinando.

### Interpretación visible
La respuesta al frontend **siempre** incluye qué entendió el sistema en lenguaje llano: *"Prospectos nuevos, canal WhatsApp, mes pasado"*. Es el mecanismo de confianza: el admin puede detectar que se le entendió mal antes de creer el número.

## FASE D — Ejecución
Cada intención ejecuta su consulta con el `organization_id` del contexto de tenant, **nunca de la petición**.

Requisitos:
- `statement_timeout` de 5 segundos
- `LIMIT` en toda intención que devuelva lista
- Presupuesto de respuesta: p95 < 3 s de extremo a extremo, incluida la traducción

### Trampas específicas del esquema — obligatorio manejarlas

| Trampa | Manejo |
|---|---|
| `leads` es conversación, `contacts` es persona | "Cuántos clientes me contactaron" va contra `contacts`; "cuántas conversaciones tuve" contra `leads` |
| `temperature` null en registros antiguos | Declarar cuántos quedaron fuera; no excluir en silencio |
| `usage_events` append-only con compensaciones negativas | Sumar todo, jamás filtrar `quantity > 0` |
| `unit_type` de LLM dinámicos | Agrupar bajo una categoría |
| `duration_seconds` en conversaciones de texto | No promediar duración en canales de texto |
| `source` null en registros previos | Categoría "Sin dato", nunca repartir proporcionalmente |
| Citas sin desenlace marcado | Categoría propia; si son muchas, la tasa de asistencia no es confiable |

## FASE E — Respuesta y verificación
La respuesta lleva: interpretación, datos exactos, y una frase de contexto redactada por el LLM.

**Verificación post-redacción:** contrastar las cifras del texto contra los datos. Si aparece un número que no está, descartar la redacción y devolver solo los datos. **Un resultado sin narrativa es aceptable; uno con cifras inventadas no.**

### Advertencias automáticas

- Todo porcentaje devuelve su **denominador**
- Con menos de ~20 casos, marcar como poco significativo
- Declarar siempre los **registros excluidos por falta de dato**
- Los valores monetarios declaran **sobre cuántos cierres con monto** se calcularon

## FASE F — Preguntas no resueltas
Tabla `unanswered_questions`: `organization_id`, `question`, `reason` (`no_resuelta` / `requiere_aclaracion` / `error`), `created_at`.

**Es el activo más valioso del módulo.** Decide qué intenciones construir en la v2 con datos reales en vez de suposiciones. Endpoint de consulta para el superadmin, agregado entre organizaciones.

## FASE G — Guardas de costo y acceso
- La llave del LLM es del cliente y él paga cada consulta.
- Límite de consultas por organización y día, configurable, con default conservador
- Límite por usuario y minuto
- **Caché:** misma pregunta normalizada, misma organización, mismo periodo resuelto → resultado cacheado con TTL corto
- Registrar tokens en `usage_events`
- Al rebasar el límite, mensaje accionable, no un error genérico

**Entitlement:** feature `natural_language_reports`, planes `pro` en adelante, con la guarda de que `llm_api_key` esté presente y validada. Si la llave falla, mensaje que apunte a la pantalla de configuración de IA.

## Documentación
- Esta es una característica importante, la cual se debe documentar con la ayuda del skill [doc-coauthoring] e integrar a AGENTS.md para el en un futuro pueda incrementar su alcance de reportes en base a las nuevas caracteristicas que se vayan implementando al sistema.

## Pruebas
- Cada intención con al menos tres formulaciones distintas de la misma pregunta
- Pregunta fuera del catálogo devuelve `no_resuelta` y queda registrada
- Pregunta ambigua ("¿cómo voy?") devuelve `requiere_aclaracion`, no adivina
- JSON inválido del LLM se trata como no resuelta, no se repara
- Resolución de periodo correcta en zona horaria de la organización
- Aislamiento: una consulta del tenant A nunca devuelve datos del tenant B
- Verificación de cifras: una redacción con número inventado se descarta
- Compensaciones negativas incluidas en los totales de costo
- Registros con `temperature` null declarados, no omitidos
- Límite de tasa produce mensaje accionable
- Feature sin llave validada no se puede usar
- Cada rechazo con su contraparte de éxito

## Qué NO hacer
- No generar SQL, en ninguna variante ni "solo para casos avanzados"
- No exponer el esquema real al modelo
- No aproximar a la intención más cercana cuando ninguna encaja
- No devolver un número sin su contexto de cobertura
- No agregar intenciones fuera de las 18 antes de tener datos de la Fase F