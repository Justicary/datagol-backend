# Análisis Técnico y Hallazgos de Integraciones: ElevenLabs, Cal.com, Google Maps y Resend

Este documento consolida los hallazgos técnicos, causas raíz y resoluciones operativas derivadas de las pruebas de QA y validación en vivo del ecosistema de Datagol API.

---

## 1. Captura y Extracción de Datos en ElevenLabs (Post-Call Analysis)

### Contexto del Problema
En pruebas con llamadas reales, el CRM registraba en la sección de direcciones:
- **Calle y Número:** `"Sí"`
- **Ciudad:** `"San Andrés Cholula"`
- **Estado:** `"Interesado"`
- **C.P.:** `"72825"`

### Causa Raíz
* **Naturaleza del origen:** Estos campos no provienen de un tool call en tiempo real, sino del módulo **Post-Call Analysis $\rightarrow$ Data Collection** configurado en el agente de ElevenLabs.
* **Ambigüedad en Prompts de Extracción:**
  1. `direccion_prospecto`: El criterio de extracción fue interpretado por el LLM como una pregunta booleana (*"¿El usuario dio su dirección?"*), extrayendo `"Sí"`.
  2. `giro_negocio`: Ocurrió el mismo comportamiento de confirmación binaria (`"Sí"`).
  3. `estado_prospecto`: El LLM interpretó "Estado" como el sentimiento/interés del prospecto (*"Interesado"*) en lugar de la **Entidad Federativa / Estado Geográfico** (*"Puebla"*).

### Corrección Aplicada en ElevenLabs Data Collection
| Campo | Tipo | Criterio / Descripción Obligatoria |
| :--- | :--- | :--- |
| `direccion_prospecto` | `string` | Extrae textualmente únicamente la calle, número exterior/interior y colonia del prospecto (ej. '1a Cerrada Real de la Hacienda #6-B, Col. Real de Santa Clara 2'). No respondas 'Sí' ni 'No'. Deja en null si no la proporcionó. |
| `giro_negocio` | `string` | Extrae el rubro, giro comercial o tipo de negocio del cliente (ej. 'Restaurante de comida rápida', 'Clínica dental', 'Ferretería'). No respondas 'Sí' ni 'No'. |
| `estado_prospecto` | `string` | Nombre del Estado o Entidad Federativa donde se ubica el negocio o domicilio del cliente (ej. 'Puebla', 'CDMX', 'Nuevo León'). No confundir con el estado de ánimo o interés del cliente. |

---

## 2. Integración de Calendario (Cal.com v2 API)

### 2.1 Error al Agendar Cita (`POST /tools/:token/booking`)
* **Síntoma:** Envío de payload completo con `startTime: "2026-08-17T10:00:00"` y respuesta de la API:
  `{ "booked": false, "message": "No puedo agendar la cita en este momento..." }`
* **Causa Raíz:**
  * La API v2 de Cal.com (`POST /v2/bookings`) asume por defecto formato **UTC** para fechas sin indicador de zona horaria.
  * `"2026-08-17T10:00:00"` fue interpretado como **10:00 UTC = 04:00 AM (Hora de México)**.
  * Al estar fuera del horario laboral, Cal.com devolvió `400 BadRequestException: "User either already has booking at this time or is not available"`.
* **Solución Técnica:**
  * Al enviar fechas a Cal.com, incluir siempre el offset explícito (`2026-08-17T10:00:00-06:00`) o la conversión ISO UTC correspondiente al `timeZone` de la llamada (`2026-08-17T16:00:00.000Z`). Con este formato, Cal.com responde `201 Created`.

### 2.2 Consulta de Disponibilidad (`checkAvailability` y Ventana 12:30 - 13:30)
* **Síntoma:** Cal.com responde `slots: {}` para una ventana de 12:30 a 13:30 aunque el calendario de Google esté vacío.
* **Causa Raíz:**
  1. **Duración y pasos del Event Type:** El evento tiene una duración fija de **60 minutos** con bloques generados en punto de la hora (`09:00`, `10:00`, `11:00`, `12:00`, `13:00`, etc.).
  2. **Incompatibilidad de bloque:** Una cita de 60 minutos iniciada a las 12:00 termina a las 13:00 (no entra completa en 12:30-13:30), y la de las 13:00 termina a las 14:00 (excede las 13:30). No existe ningún slot que inicie a las 12:30.
  3. **Desfase UTC:** Sin offset, 12:30 UTC equivale a las 06:30 AM locales.
* **Recomendación para el Agente:** Instruir al System Prompt del agente a consultar rangos amplios (ej. turno matutino `09:00 a 14:00` o vespertino `13:00 a 18:00`) en lugar de acotar la búsqueda a intervalos de 30 o 60 minutos.

---

## 3. Geolocalización de Prospectos (Google Maps Geocoding)

### Flujo Operativo y Persistencia
1. **Entitlements:** La organización debe contar con la feature `geolocation` activa (verificada vía `getOrganizationFeatures`).
2. **Extracción y Servicio:** `process-call-completed.ts` invoca `geocodeAddress(fastify, orgId, { address, city, state, zip })` consumiendo el secreto `google_maps_key` desde Vault.
3. **Persistencia en Base de Datos:**
   * `call_logs.customer_lat` y `call_logs.customer_lng` (`numeric`).
   * `contact_addresses.latitude` y `contact_addresses.longitude` (`numeric`) mediante la función `resolve_contact_address()`.

### Restricción de API Key en Google Cloud Console
* **Error detectado:** `REQUEST_DENIED: "API keys with referer restrictions cannot be used with this API."`
* **Solución requerida en GCP:**
  * Las llamadas de Geocodificación se originan desde el servidor backend (Node.js).
  * La API Key en Google Cloud Console debe configurarse con **Restricción de aplicación = Ninguna (None)** o **Direcciones IP**, y con **Restricción de API = Geocoding API**.

---

## 4. Capacidades del Servicio de Email (`src/services/email.ts`)

### Capacidades Implementadas en Datagol API
| Función | Destinatario | Disparador |
| :--- | :--- | :--- |
| `sendCallSummaryEmail` | Negocio | Minuta ejecutiva, transcripción y sentimiento tras completar una llamada. |
| `sendHotLeadAlertEmail` | Negocio | Alerta urgente cuando un prospecto estuvo caliente pero **no agendó cita** (`notify-hot-lead.ts`). |
| `sendProspectSummaryEmail` | Prospecto | Resumen de cortesía si el agente comprometió envío de información. |
| `sendElevenLabsCreditsAlertEmail` | Negocio | Alerta de umbral de créditos de ElevenLabs (15%, 10%, 5%). |

### Gestión de Citas y Confirmaciones
* **Citas Exitosas:** Cal.com gestiona de forma nativa los correos transaccionales de confirmación con invitación de calendario (`.ics`) tanto al anfitrión como al asistente.
* **Citas No Concretadas / Fallidas:** Se gestionan mediante la alerta de **Hot Lead** (`sendHotLeadAlertEmail`) para que el equipo humano contacte de inmediato al cliente.
