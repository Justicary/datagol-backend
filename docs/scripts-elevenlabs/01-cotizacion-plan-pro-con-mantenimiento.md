# 🧪 Guión 01: Cotización Formal de Plan Pro con Mantenimiento Mensual

Este guión prueba el **flujo estándar de cotización comercial**, evaluando la captura previa de datos de contacto, la agregación del plan principal, la oferta automática del complemento sugerido y la emisión formal con folio.

---

### 🎭 Rol del Tester
Eres un prospecto interesado en automatizar la atención telefónica y de WhatsApp de tu empresa de servicios. Llamas buscando una propuesta formal por escrito.

---

### 📞 Guión Paso a Paso

#### Paso 1: Saludo e Indagación de Plan
* **Tester:**
  > *"Hola, buenas tardes. Me gustaría saber qué incluye el Plan Pro Omnicanal y cuánto cuesta."*
* **Comportamiento Esperado de Yeli:**
  * Responde de memoria sin silencios (latencia 0 ms).
  * Menciona los beneficios clave (Single page, WhatsApp Cloud API, widget web, 20 llamadas concurrentes).
  * Menciona la inversión de instalación: *"trece mil novecientos noventa y nueve pesos más IVA"*.
  * No ofrece cotizar todavía ni llama herramientas.

#### Paso 2: Solicitud de Cotización (Verificación de Regla de Oro)
* **Tester:**
  > *"Me parece perfecto. ¿Me podrías mandar una cotización formal a mi correo?"*
* **Comportamiento Esperado de Yeli:**
  * **CRÍTICO:** NO debe ejecutar `quotation_cart_set_item` en este turno.
  * Responde cálidamente pidiendo los datos:
    > *"Con mucho gusto te preparo la cotización formal, ¿con quién tengo el gusto y a qué correo electrónico te gustaría que te la hagamos llegar?"*

#### Paso 3: Aporte de Datos
* **Tester:**
  > *"Mi nombre es Juan Carlos Morales y mi correo es jc.morales@empresa.com"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Dame cinco segundos, estoy registrando tus datos y el plan en el sistema..."*
  * **Herramienta invocada:** `quotation_cart_set_item` con `sku: "PLAN-PRO"`, `quantity: 1`, `customerName` y `customerEmail`.
  * **Complemento sugerido:** Al recibir `suggestedComplement` del backend, Yeli confirma que agregó el plan y ofrece la iguala mensual:
    > *"Ya quedó registrado el Plan Pro Omnicanal. Este plan cuenta con una iguala de mantenimiento mensual opcional por mil novecientos noventa y nueve pesos más IVA. ¿Deseas incluirla en tu cotización?"*

#### Paso 4: Aceptación del Complemento
* **Tester:**
  > *"Sí, por favor, inclúyela también."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera breve.**
  * **Herramienta invocada:** `quotation_cart_set_item` con `sku: "MANT-PRO-MENSUAL"`, `quantity: 1`.
  * Informa el total inicial acumulado verbalizado con `spokenTotal`.

#### Paso 5: Emisión y Cierre
* **Tester:**
  > *"Excelente, por favor emítela y mándamela por correo."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Un segundo mientras emito tu cotización oficial..."*
  * **Herramienta invocada:** `quotation_finalize` con `channels: ["email"]`.
  * Confirma el folio asignado:
    > *"Listo Juan Carlos, tu cotización con folio COT-2026-000001 ya quedó emitida y te la envié a tu correo jc.morales@empresa.com. ¿Hay algo más en lo que te pueda ayudar?"*

---

### ✅ Criterios de Éxito
- [✅] No hubo silencios muertos (> 1.5 s) gracias a las frases de transición.
- [✅] Yeli pidió nombre y correo **antes** de tocar el carrito.
- [✅] Ofreció el mantenimiento mensual como opcional, nunca lo impuso.
- [✅] Leyó los precios con palabras naturales (no dígitos aislados).
- [✅] Finalizó proporcionando el número de folio oficial.

