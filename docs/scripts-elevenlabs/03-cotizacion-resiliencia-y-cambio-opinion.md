# 🧪 Guión 03: Resiliencia en Búsqueda, Retiro de Partidas y Envío Dual

Este guión pone a prueba la **resiliencia conversacional** del agente frente a términos imprecisos (*"Unicanal"*, *"el paquete básico"*), la modificación del carrito sobre la marcha (agregar y luego arrepentirse para retirar una partida) y la entrega dual (correo y WhatsApp simultáneos).

---

### 🎭 Rol del Tester
Eres un cliente indeciso que no recuerda con precisión el nombre del paquete. Primero agregas el plan con su mantenimiento, pero al escuchar el total decides quitar el mantenimiento para abaratar la inversión inicial.

---

### 📞 Guión Paso a Paso

#### Paso 1: Búsqueda con Nombre Impreciso
* **Tester:**
  > *"Hola, me habían recomendado un paquete que creo que se llama 'Platino 360' o algo así, ¿lo tienen?"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Permíteme unos segundos mientras busco en el catálogo..."*
  * **Herramienta invocada:** `quotation_search` con `query: "Platino 360"`.
  * Deduce que se trata del **Elite 360** y lo aclara cordialmente:
    > *"Seguramente te refieres a nuestro Plan Elite 360. Es la solución completa para empresas por veintinueve mil novecientos noventa y nueve pesos de pago único más IVA."*

#### Paso 2: Interés y Captura Previa de Contacto
* **Tester:**
  > *"Ese mero. Cotízamelo, por favor."*
* **Comportamiento Esperado de Yeli:**
  * Solicita nombre y correo antes de agregar al carrito:
    > *"Con mucho gusto. Para armarte la propuesta formal, ¿me indicas tu nombre completo y tu correo electrónico?"*

#### Paso 3: Aporte de Datos
* **Tester:**
  > *"Me llamo Fernando Estrada y mi correo es fer.estrada@logistica.com"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera.**
  * **Herramienta invocada:** `quotation_cart_set_item` con `sku: "PLAN-PRO"`.
  * Ofrece el mantenimiento mensual sugerido (`MANT-PRO-MENSUAL` por $1,999 MXN).

#### Paso 4: Aceptar Mantenimiento
* **Tester:**
  > *"Sí, agrégalo también."*
* **Comportamiento Esperado de Yeli:**
  * Agrega `MANT-PRO-MENSUAL` con `quotation_cart_set_item`.
  * Confirma el total acumulado inicial: *"quince mil novecientos noventa y ocho pesos más IVA"*.

#### Paso 5: Cambio de Opinión (Retirar Partida)
* **Tester:**
  > *"Mmm, ¿sabes qué? Se me sale un poco del presupuesto para empezar. Mejor quita el mantenimiento y déjame solo el plan Pro."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Un segundo mientras retiro el mantenimiento de tu cotización..."*
  * **Herramienta invocada:** `quotation_cart_remove_item` con `sku: "MANT-PRO-MENSUAL"`.
  * Informa el nuevo total ajustado: *"trece mil novecientos noventa y nueve pesos de pago único más IVA"*.

#### Paso 6: Solicitar Envío Dual (Correo y WhatsApp)
* **Tester:**
  > *"Excelente. Mándamelo por favor a mi correo y también a mi WhatsApp a este mismo número desde el que llamo."*
* **Comportamiento Esperado de Yeli:**
  * Si detecta el caller ID o pide confirmar el número a 10 dígitos.
  * **Frase de espera:** *"Dame un momento mientras emito tu cotización..."*
  * **Herramienta invocada:** `quotation_finalize` con `channels: ["email", "whatsapp"]`.
  * Proporciona el número de folio oficial (ej. `COT-2026-000002`).

---

### ✅ Criterios de Éxito
- [ ] Recuperó correctamente el Plan Pro ante un término impreciso (*"Unicanal"*).
- [ ] Eliminó limpiamente la partida del carrito al solicitarlo el cliente.
- [ ] Recalculó el total exacto sin alucinar sumas ni restar incorrectamente.
- [ ] Ejecutó la emisión dual especificando tanto `email` como `whatsapp`.

