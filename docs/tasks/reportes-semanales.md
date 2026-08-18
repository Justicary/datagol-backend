# TASK — BYOK, reportes semanales y análisis de competencia

**Proyecto:** `datagol-backend`
**Referencia obligatoria:** `AGENTS.md` de este repositorio
**Orden:** las tres fases son secuenciales. La A bloquea a la B, y la B a la C.

## Contexto

Tres módulos nuevos, disponibles a partir del plan **elite**:

- **BYOK de LLM** — el cliente aporta su propia llave de proveedor de IA. Para Datagol utilizaremos https://openrouter.ai/docs/quickstart y haremos pruebas con el modelo deepseek/deepseek-v4-flash-0731.
- **Reporte de planificación** — lunes 6:00 AM, hora local de la organización.
- **Reporte ejecutivo** — viernes, con cambios de la semana y recomendaciones, incluido análisis de competencia.

**Nueva feature 'reports' para todos los planes, disponible inicialmente para el plan elite o superior:**
- Planificador semanal de conversaciones, prospectos y citas.
- Recomendaciones basadas en datos.
- Análisis de competencia (3 sitios).
- Resumen ejecutivo semanal.

**Nota a considerar:** Como argumento de venta, Datagol puede proporcionar/configurar su propio LLM API KEY para generar los reportes. Siempre y cuando el cliente contrate la iguala mensual de mantenimiento ó activando de forma promocional por un tiempo determinado los reportes, por ejemplo en los planes 'starter' y 'pro' por un mes a determinadas organizaciones.

**Principio rector de los reportes:** el LLM **redacta**, no calcula. Todas las cifras se computan en SQL y se le entregan como datos. Un modelo que hace aritmética sobre transcripciones inventa números, y un reporte con cifras falsas es peor que no tener reporte.

## FASE A — BYOK agnóstico de LLM

### A.1 Zona horaria (bloqueador)

En la cuenta de Cal.com SE DEBE especificar forzadamente la 'Disponibilidad' (Horario de atención) y por consecuente la zona horaria.
Analiza y verifica si con la API de Cal.com podemos obtener estos datos. Si la respuesta es afirmativa, entonces el campo 'timezone' de la tabla 'organizations' no es necesario. Si la respuesta es negativa, entonces crea el campo 'timezone' en la tabla 'organizations' y siembralo desde la metadata del payload de ElevenLabs.

```
alter table organizations
  add column timezone text not null default 'America/Mexico_City';
```

El payload de ElevenLabs ya reporta la zona (`metadata.timezone`); considera sembrarla desde ahí en el onboarding.

### A.2 Almacenamiento de la credencial

Extiende el `CHECK` de `organization_secrets.secret_key` con `llm_api_key`. **Actualiza también el módulo `secret-keys.ts`** — es la fuente única de verdad y ya causó un bug cuando divergió.

La llave va a Vault, como todas. Nunca a una columna en claro, nunca a logs, nunca a una respuesta de API.

### A.3 Configuración

En `integration_settings`:

```json
"llm": {
  "provider": "openrouter",
  "model": "deepseek/deepseek-v4-flash-0731",
  "baseUrl": "https://openrouter.ai/api/v1",
  "validatedAt": null,
  "lastError": null
}
```

Módulo de constraint para `provider`: `anthropic`, `openai`, `google`, `openrouter`.

`baseUrl` solo aplica a `openrouter`. Valida que sea https. Verifica en la documentación de OpenRouter si es necesario agregar algo más.

### A.4 Adaptador

`src/services/llm/` con una interfaz común y un adaptador por proveedor. La misma lección del proveedor de voz: **nada del resto del sistema debe saber qué proveedor está en uso.**

Interfaz mínima: completar un prompt, devolver texto y conteo de tokens. Nada más.

### A.5 Validación en vivo

`POST /organizations/:id/llm/validate` — hace una llamada real y barata al proveedor con la llave capturada.

Esto no es opcional. Con BYOK obligatorio, una llave inválida silenciosa significa que un cliente paga Pro y nunca recibe reportes. La validación debe:

- Distinguir llave inválida, sin crédito, modelo inexistente y red caída
- Devolver un mensaje que el admin pueda accionar, no el error crudo del proveedor
- Guardar `validatedAt` y `lastError`
- Revalidar automáticamente antes de cada generación de reporte; si falla, notificar al admin en vez de fallar en silencio

### A.6 Metering

Registra los tokens en `usage_events` aunque el cliente pague directo al proveedor. Sirve para transparencia y para diagnosticar un reporte caro. Provider `llm`, con el modelo en `metadata`.

## FASE B — Reportes semanales

### B.1 Programación

`pg_cron` no entiende zonas horarias por organización. Corre el job cada seis horas (configurable) y filtra las organizaciones cuya hora local coincida con la programada.

Idempotencia: **un reporte por organización por semana por tipo**. Tabla `scheduled_reports` con índice único sobre `(organization_id, report_type, week_start)`. Un reintento no genera un segundo envío.

Configuración por organización: día, hora y canales. Defaults: lunes 6:00 y viernes 18:00, hora local (configurable).

### B.2 Recolección de datos — SQL, no LLM

Función que devuelva un objeto estructurado. Todo se calcula aquí.

**Reporte de lunes (planificación):**
- Citas de la semana, por día, con estado de confirmación
- Citas sin confirmar que requieren acción
- Prospectos calientes sin atender (`v_hot_leads_pending`)
- Seguimientos vencidos (`followup_at` pasado, estado pendiente)
- Huecos en la agenda dentro del horario de atención
- Contactos en `cita_agendada` sin cita futura — se agendó y se canceló
- Carga por día: qué días están saturados y cuáles vacíos

**Reporte de viernes (ejecutivo):**
- Conversaciones, prospectos, citas: esta semana contra la anterior, con variación
- Desglose por canal (voz, WhatsApp, web)
- Tasa de conversión a cita, por canal
- Costo total y costo por prospecto captado
- Prospectos perdidos y por qué (`lost_reason`)
- Movimiento del pipeline: cuántos avanzaron de etapa
- Temas recurrentes en las consultas
- Alertas: concurrencia rebasada, duración media anómala, credencial por vencer

### B.3 Generación del texto

El prompt recibe el objeto de datos y pide **únicamente** redacción y priorización. Reglas duras:

- Prohibido inventar cifras. Solo puede usar las que recibe.
- Prohibido inferir causalidad que los datos no sostienen.
- Máximo 3 recomendaciones, accionables y concretas.
- Español mexicano, tono profesional y directo.
- Si un dato viene vacío, lo omite; no lo rellena.

**Verificación post-generación:** compara las cifras del texto contra el objeto de datos. Si aparece un número que no está en los datos, descarta la generación y reintenta. Si falla dos veces, envía el reporte con los datos en formato tabular sin prosa. **Un reporte sin narrativa es aceptable; uno con cifras inventadas no.**

### B.4 Entrega

**Correo:** usa el sistema de plantillas ya implementado. Dos tipos nuevos que deben funcionar en las cinco plantillas. Respeta el límite de 90 KB.

**WhatsApp:** resumen corto, no el reporte completo. Un lunes a las 6:00 AM casi siempre cae **fuera** de la ventana de 24 horas, así que requiere plantilla aprobada. Si no hay plantilla configurada, registrar omitido con razón explícita.

El admin elige canales. Si elige ambos, WhatsApp lleva el titular y el correo el detalle.

### B.5 Entitlements

Dos features nuevas en el catálogo: `weekly_planning_report` y `weekly_executive_report`, categoría `operacion`, `requires_provider` nulo (la llave es del cliente), asignadas a `pro`, `elite` y `enterprise`.

**Guarda adicional:** ambas requieren `llm_api_key` presente y validada. Sin ella, no se pueden habilitar — el mismo patrón de la guarda de credenciales que ya existe.

## FASE C — Análisis de competencia

### C.1 Configuración

Tabla `competitor_sites`: `organization_id`, `url`, `label`, `enabled`, `last_checked_at`, `last_error`. **Máximo 3 sitios por organización.**

### C.2 Recolección responsable

Requisitos no negociables:

- **Respetar `robots.txt`.** Si prohíbe el path, no se consulta y se registra la razón.
- **User-Agent identificado** con nombre y URL de contacto de Datagol. Nada de suplantar un navegador.
- **Un acceso por sitio por semana.** No es un crawler. La idea es buscar promociones o eventos para informarlos.
- **Timeout corto** y sin reintentos agresivos.
- Solo la página indicada, sin seguir enlaces.
- Guardar únicamente texto extraído, nunca el HTML completo ni recursos.

### C.3 Comparación

Guarda una instantánea semanal del texto. El análisis compara contra la anterior y reporta **cambios**, no descripciones: precios que se movieron, servicios nuevos, promociones, cambios de mensaje.

La primera semana no hay comparación; solo se establece la línea base y se dice así.

### C.4 Advertencias obligatorias

- El reporte etiqueta esta sección como **aproximada, basada en contenido público**.
- Si un sitio bloqueó el acceso, se dice; no se omite en silencio.
- El prompt prohíbe explícitamente especular sobre lo que no está en el texto extraído.

### C.5 Feature aparte

`competitor_analysis`, plan `elite` y `enterprise`. Tiene costo de tokens y riesgo distinto; no debe ir junto con los reportes básicos. Puede ser activado por el superadmin para determinadas organizaciones.

## Pruebas

- Zona horaria: una organización en `America/Mexico_City` recibe el reporte a las 6:00 locales, no UTC.
- Idempotencia: dos ejecuciones del job en la misma semana producen un envío.
- Llave inválida: el reporte no se envía y el admin recibe notificación.
- Verificación de cifras: una generación con un número inventado se descarta.
- Semana sin actividad: el reporte se genera y lo dice, sin inventar contenido.
- `robots.txt` que prohíbe: no se consulta y se registra.
- Sitio caído: el reporte se envía sin esa sección, indicándolo.
- Feature sin llave validada: no se puede habilitar.
- Cada rechazo con su contraparte de éxito.