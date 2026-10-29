# 🧪 Guión 05: Gestión de Citas (Consulta, Reagendado y Cancelación)

Este guión evalúa el manejo de citas preexistentes en la agenda: cómo responde el agente cuando el cliente pregunta *"¿A qué hora es mi cita?"*, cómo reprograma a una nueva fecha y hora, y cómo gestiona una cancelación con motivo.

---

### 🎭 Rol del Tester
Eres un cliente que ya tiene una cita agendada en Datagol. Primero llamas para verificar la hora, luego decides reprogramarla para otro día y, en una variante, solicitas cancelarla.

---

### 📞 Guión Paso a Paso

#### Escenario A: Consulta de Cita Existente

* **Tester:**
  > *"Hola, tengo una cita agendada para estos días pero no recuerdo la hora exacta, ¿me podrías recordar cuándo es?"*
* **Comportamiento Esperado de Yeli:**
  * Solicita al menos el correo electrónico o nombre si no viene identificado por teléfono:
    > *"Con gusto te ayudo a consultar tu cita. ¿Me compartes tu nombre completo o el correo con el que agendaste?"*
* **Tester:**
  > *"Mi correo es sramirez@clinica.mx"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Dame un momento mientras consulto los detalles en el sistema..."*
  * **Herramienta invocada:** `getAppointmentDetails` con `customerEmail: "sramirez@clinica.mx"`.
  * Informa con precisión:
    > *"Tienes una cita programada para el viernes veintiocho de octubre a las cuatro de la tarde. ¿Deseas hacer alguna modificación?"*

---

#### Escenario B: Reagendar Cita

* **Tester:**
  > *"Sí, me surgió un viaje imprevisto y no podré asistir. ¿La podemos mover para el lunes siguiente a las once de la mañana?"*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Permíteme verificar disponibilidad en ese horario..."*
  * **Herramienta invocada:** `checkAvailability` para verificar que el lunes a las 11:00 esté libre.
  * Si está libre, ejecuta `rescheduleAppointment`.
  * Confirma el cambio:
    > *"Listo, tu cita ha sido reprogramada para el lunes primero de noviembre a las once de la mañana. Te enviamos la confirmación actualizada a tu correo."*

---

#### Escenario C: Cancelación con Motivo

* **Tester:**
  > *"Hola, hablo para cancelar mi cita agendada a nombre de Sofía Ramírez."*
* **Comportamiento Esperado de Yeli:**
  * Confirma la identidad y pregunta sutilmente el motivo de cancelación:
    > *"Lamento que tengas que cancelar, Sofía. Con gusto te ayudo. ¿Nos podrías compartir brevemente el motivo para registrarlo en el sistema?"*
* **Tester:**
  > *"Decidimos pausar el proyecto hasta el próximo trimestre."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera.**
  * **Herramienta invocada:** `cancelAppointment` con nombre, correo y `reason: "Proyecto pausado hasta próximo trimestre"`.
  * Responde de forma educada y deja la puerta abierta:
    > *"Tu cita ha quedado cancelada en el sistema. Quedamos a tus órdenes cuando decidan retomar el proyecto. ¡Que tengas un excelente día!"*

---

### ✅ Criterios de Éxito
- [ ] No ejecutó cancelaciones ni cambios sin verificar antes la identidad del contacto.
- [ ] Capturó el motivo de cancelación de manera sutil y sin fricción.
- [ ] Formuló una sola pregunta por turno y mantuvo el tono profesional y empático.

