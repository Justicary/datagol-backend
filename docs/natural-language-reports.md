# Manual Técnico — Módulo de Reportes en Lenguaje Natural (Datagol Backend)

Este documento detalla la arquitectura, el catálogo de intenciones, la gestión de dimensiones temporales y el procedimiento para extender el sistema con nuevas intenciones de reporte en la v2.

---

## 🏛️ 1. Arquitectura: "El LLM Traduce, no Consulta"

### Principio Rector
El modelo de lenguaje **nunca genera SQL, nunca tiene acceso a la base de datos y nunca realiza cálculos matemáticos**. 

Cualquier propuesta que pretenda que el LLM escriba consultas SQL en runtime queda **estrictamente prohibida** por dos razones fundamentales:
1. **Seguridad y Aislamiento Multi-Tenant:** Un LLM con conexión a la base de datos es un vector directo de fuga de información entre organizaciones.
2. **Corrección Semántica:** Esquemas con matices de negocio (`leads` como conversación vs `contacts` como persona; `usage_events` append-only con asientos compensatorios negativos; `temperature` nulo en registros históricos) producen consultas SQL semánticamente erróneas que pasan desapercibidas en auditorías.

### Flujo de Ejecución

```
1. Pregunta en español (POST /api/organizations/:id/reports/ask)
       │
       ▼ (LLM clasifica según catálogo dinámico de 18 intenciones y fecha local)
2. Intención estructurada JSON { status, intent, parameters, interpretation }
       │
       ▼ (Validación con Zod; si falla -> clasifica como no_resuelta)
3. Validación estricta en TypeScript
       │
       ▼ (Código determinista con organization_id del tenant autenticado)
4. Ejecución de consulta parametrizada con timeout de 5 segundos
       │
       ▼
5. Resultado numérico exacto + Advertencias de cobertura
       │
       ▼ (LLM redacta 1 frase concisa de contexto)
6. Redacción contextual opcional
       │
       ▼ (Verificación determinista anti-alucinación)
7. Verificación de cifras: si aparece un número no presente en los datos, se descarta la redacción
       │
       ▼
8. Respuesta estructurada al cliente + Registro de tokens consumidos
```

---

## 📋 2. Catálogo Oficial de Intenciones (v1 - 18 Intenciones)

Las intenciones están agrupadas en 5 familias y definidas en `src/services/reports/intents/`:

### 📅 Agenda
1. `listado_citas`: Listado de citas agendadas en el periodo con cliente, teléfono, estado y dirección (`LIMIT 50`).
2. `conteo_citas`: Total numérico de citas agendadas o programadas en el periodo.
3. `citas_por_estado`: Desglose porcentual y numérico por estado (`programada`, `confirmada`, `completada`, `no_asistio`, `cancelada`, `reprogramada`).
4. `citas_sin_desenlace`: Citas pasadas (`start_time < now()`) que siguen en `programada` o `confirmada` sin resultado marcado en el CRM.

### ⏳ Pendientes
5. `pendientes_abiertos`: Prospectos en etapas tempranas (`lead`, `prospecto`, `oportunidad`) que requieren seguimiento.
6. `seguimientos_vencidos`: Citas pasadas sin desenlace y prospectos sin movimiento en más de 7 días.
7. `prospectos_calientes_sin_atender`: Leads con `temperature = 'caliente'` sin cita agendada (declara nulos).

### 🎯 Captación
8. `conteo_prospectos_nuevos`: Total de personas o contactos únicos creados en el periodo (`contacts`).
9. `listado_prospectos`: Lista de prospectos recientes con etapa y datos de contacto (`LIMIT 50`).
10. `conteo_conversaciones`: Total de llamadas/conversaciones recibidas en el periodo (`leads`).
11. `atribucion_origen`: Distribución de prospectos según fuente de captación (`leads.source`), declarando registros sin dato.

### 💰 Costo
12. `costo_total`: Gasto acumulado en USD en `usage_events` en el periodo (incluyendo compensaciones negativas).
13. `costo_por_canal`: Gasto y volumen de eventos agrupados por proveedor (voz, LLM, telefonía, WhatsApp).
14. `costo_por_prospecto`: Costo promedio de adquisición por prospecto (CAC estimado = costo total / prospectos nuevos).
15. `costo_por_cita`: Costo promedio por cita agendada (costo total / citas agendadas).

### 📈 Resultado
16. `resultado_negocio`: Clientes ganados (`won_at`), monto total vendido (`deal_value`), ticket promedio, min y max.
17. `cumplimiento_citas`: Tasa de asistencia real (asistieron vs no asistieron vs canceladas vs sin marcar).
18. `tasa_conversion`: Conversión de conversaciones a citas y de prospectos a clientes ganados.

---

## 🌐 3. Dimensiones y Manejo de Zona Horaria

### Zona Horaria de la Organización
- La fecha y los periodos (`hoy`, `ayer`, `esta_semana`, `semana_pasada`, `este_mes`, `mes_pasado`, `ultimos_n_dias`, `rango_explicito`) **siempre se resuelven en la zona horaria local de la organización** (`organizations.timezone`, default `'America/Mexico_City'`).
- Las fronteras del día local (00:00:00 a 23:59:59.999) se traducen a marcas de tiempo UTC para las consultas a Postgres.

---

## 🛡️ 4. Trampas del Esquema de Base de Datos

Todo desarrollador debe respetar las siguientes reglas al escribir o modificar intenciones:

| Trampa | Regla Obligatoria |
|---|---|
| `leads` vs `contacts` | `leads` = conversación / llamada; `contacts` = persona única. "Cuántos prospectos llegaron" consulta `contacts`; "cuántas llamadas tuve" consulta `leads`. |
| `temperature` nulo | Los registros antiguos no tienen temperatura. Declarar siempre cuántos quedaron fuera (`sin_clasificar`), nunca omitirlos en silencio. |
| `usage_events` compensaciones | `usage_events` es append-only con asientos compensatorios negativos. Se debe sumar todo (`SUM(amount_usd)`), jamás filtrar `quantity > 0` o `amount_usd > 0`. |
| `duration_seconds` en texto | No promediar duración en canales que no sean de voz (WhatsApp / Web tienen duración 0 o irrelevante). |
| `source` nulo | Declarar como categoría `"sin_dato"`, nunca inventar ni prorratear orígenes históricos. |
| Citas sin desenlace | Si hay muchas citas pasadas en `programada`/`confirmada`, advertir que la tasa de asistencia calculada no es confiable hasta que el CRM esté actualizado. |

---

## 🚀 5. Guía para Agregar una Nueva Intención en la v2

Para incorporar una nueva intención (ejemplo: `frecuencia_reagendado`):

1. **Crear archivo de intención:** Crear `src/services/reports/intents/frecuencia-reagendado.ts` implementando la interfaz `NlIntentDefinition`.
2. **Definir esquema Zod y parámetros:** Declarar `parametersSchema` con los filtros permitidos.
3. **Registrar en constantes:** Agregar la clave en `NL_INTENT_KEYS` en `src/types/natural-reports.ts`.
4. **Exportar en el índice:** Agregar la intención a `ALL_INTENTS` en `src/services/reports/intents/index.ts`.
5. **Escribir pruebas unitarias:** En `__tests__/nl-intents.test.ts`, verificar la intención con al menos 3 formulaciones de preguntas y datos simulados.

---

## 📊 6. Bitácora de Preguntas No Resueltas (`unanswered_questions`)

Las preguntas que el LLM clasifica como `no_resuelta`, `requiere_aclaracion` o que producen un error de ejecución se almacenan en la tabla `unanswered_questions`.

### Endpoints Disponibles:
- **Para Administradores de la Organización:**
  - `GET /api/organizations/:id/reports/unanswered-questions` (lista preguntas de la organización).
- **Para Superadministradores de la Plataforma:**
  - `GET /api/admin/reports/unanswered-questions` (lista transversal con filtros).
  - `GET /api/admin/reports/unanswered-questions/summary` (resumen de motivos y preguntas más frecuentes para priorizar la v2).
