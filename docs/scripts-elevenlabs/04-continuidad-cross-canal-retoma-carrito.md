# 🧪 Guión 04: Continuidad Cross-Canal y Retoma de Cotización Previa

Este guión evalúa la **continuidad conversacional (Decisión D2 del manual técnico)**: la capacidad del agente para reconocer a un cliente recurrente por su número telefónico o correo electrónico, verificar si tiene un carrito guardado en estado `borrador` o `abandonada`, y ofrecerle retomarlo en lugar de forzarlo a empezar de cero.

---

### 🎭 Rol del Tester
Eres un cliente que llamó ayer y dejó una cotización armada pero no la finalizó porque tenías que entrar a una reunión. Vuelves a llamar hoy para continuarla o cerrarla.

---

### 📞 Guión Paso a Paso

#### Paso 1: Saludo de Cliente Recurrente
* **Tester:**
  > *"Hola, buenas tardes. Ayer estuve platicando con ustedes sobre un plan y me quedé a medias en mi cotización. ¿Me pueden ayudar a retomarla?"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Permíteme unos segundos mientras verifico en el sistema con tus datos..."*
  * **Herramienta invocada:** `quotation_cart_view`.
  * **Reconocimiento:** El backend detecta `resumed: true` y devuelve el resumen de lo guardado.
  * Yeli responde amablemente:
    > *"¡Hola! Veo que tenías guardada una cotización con el Plan Pro Omnicanal por trece mil novecientos noventa y nueve pesos más IVA. ¿Te gustaría continuar con esta propuesta o prefieres hacerle algún cambio?"*

#### Paso 2: Opción A — Confirmar y Emitir
* **Tester:**
  > *"Sí, justo esa era. Ya la revisé con mi socio y queremos avanzar. Mándamela a mi correo por favor."*
* **Comportamiento Esperado de Yeli:**
  * Si ya cuenta con el nombre y correo del contacto previo, solo los confirma:
    > *"Perfecto. Te la confirmo a nombre de Fernando Estrada al correo fer.estrada@logistica.com, ¿es correcto?"*
  * Al recibir confirmación, ejecuta `quotation_finalize` con `channels: ["email"]`.
  * Emite el folio y se despide amablemente.

#### Paso 3: Opción B (Variante de Prueba) — Agregar un Complemento
* **Tester (Alternativo):**
  > *"Sí, pero me gustaría agregarle también la iguala de mantenimiento mensual que me comentaron ayer."*
* **Comportamiento Esperado de Yeli:**
  * **Herramienta invocada:** `quotation_cart_set_item` con `sku: "MANT-PRO-MENSUAL"`, `quantity: 1`.
  * Actualiza el carrito preexistente y lee el nuevo total antes de proceder a la emisión.

---

### ✅ Criterios de Éxito
- [ ] Invocó `quotation_cart_view` temprano en la conversación ante la mención de una cotización previa.
- [ ] Verbalizó con exactitud las partidas que ya estaban en el carrito guardado.
- [ ] No borró el carrito existente ni duplicó el borrador en la base de datos.
- [ ] Emitió con folio oficial respetando los datos preexistentes del contacto.

