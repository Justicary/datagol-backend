# 📋 Guía Metodológica para Pruebas del Agente Yeli (ElevenLabs)

Esta carpeta contiene los **guiones oficiales de prueba conversacional** diseñados para evaluar la calidad, robustez, latencia y cumplimiento del agente de inteligencia artificial **Yeli** en ElevenLabs conectado al backend de Datagol.

---

## 🎯 Criterios de Evaluación Obligatorios (QA Checklist)

Al ejecutar cualquier llamada de prueba, el tester debe verificar los siguientes 5 pilares:

1. **Enmascaramiento de Latencia (Frases de Espera):**
   * Antes de cualquier herramienta de base de datos o agenda, el agente **debe decir una frase de transición** (ej. *"Dame cinco segundos, estoy consultando en el sistema..."*).
   * **Fallo grave:** Silencios mayores a 1.5 segundos sin previo aviso verbal.
2. **Captura Previa de Datos de Contacto (Regla de Oro):**
   * El agente **nunca** debe invocar `quotation_cart_set_item` sin haber obtenido antes el **nombre completo** y el **correo electrónico** del cliente.
3. **Cero Alucinación de Precios y Lectura Natural:**
   * El agente lee únicamente el `spokenTotal` devuelto por el backend (ej. *"trece mil novecientos noventa y nueve pesos de pago único, más IVA"*). Nunca inventa ni suma números mentalmente.
4. **Prohibición Estricta de Descuentos:**
   * El agente no puede prometer ni aplicar rebajas o descuentos por su cuenta; aclara que solo un asesor humano desde el panel administrativo puede autorizarlos.
5. **No Repetición ni Monotonía:**
   * El agente no repite saludos (*"Hola, soy Yeli..."* en el segundo turno), no repite frases idénticas de espera y no vuelve a pedir datos que ya se le dieron.

---

## 📂 Catálogo de Guiones de Prueba

| # | Archivo | Caso de Uso Principal | Herramientas Involucradas |
|---|---|---|---|
| **01** | [`01-cotizacion-plan-pro-con-mantenimiento.md`](./01-cotizacion-plan-pro-con-mantenimiento.md) | Flujo Feliz de Cotización con Complemento Sugerido | `quotation_cart_set_item`, `quotation_finalize` |
| **02** | [`02-agendamiento-citas-calcom.md`](./02-agendamiento-citas-calcom.md) | Agendamiento de Cita Demostrativa en Cal.com | `checkAvailability`, `bookAppointment` |
| **03** | [`03-cotizacion-resiliencia-y-cambio-opinion.md`](./03-cotizacion-resiliencia-y-cambio-opinion.md) | Búsqueda Difusa, Retiro de Partida y Envío Dual | `quotation_search`, `quotation_cart_remove_item`, `quotation_cart_view`, `quotation_finalize` |
| **04** | [`04-continuidad-cross-canal-retoma-carrito.md`](./04-continuidad-cross-canal-retoma-carrito.md) | Continuidad Cross-Canal y Retoma de Cotización Previa | `quotation_cart_view`, `quotation_finalize` |
| **05** | [`05-gestion-citas-reagendar-cancelar.md`](./05-gestion-citas-reagendar-cancelar.md) | Consulta, Reagendado y Cancelación de Citas | `getAppointmentDetails`, `rescheduleAppointment`, `cancelAppointment` |
| **06** | [`06-limites-seguridad-y-transferencia-humana.md`](./06-limites-seguridad-y-transferencia-humana.md) | Presión Comercial, Lenguaje Ofensivo y Transferencia | `call_transfer` / derivación a Víctor Mancera |

