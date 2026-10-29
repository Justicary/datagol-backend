# 🧪 Guión 02: Agendamiento de Cita Demostrativa en Cal.com

Este guión evalúa el flujo de **agendamiento de reuniones en vivo**, la consulta de slots disponibles en Cal.com con offset de huso horario (`America/Mexico_City`), la restricción de ofrecer máximo 2 opciones y la confirmación final de la cita.

---

### 🎭 Rol del Tester
Eres un cliente que quiere ver una demostración en vivo del funcionamiento del agente antes de tomar una decisión de compra. Deseas una cita para el próximo viernes o día hábil por la tarde.

---

### 📞 Guión Paso a Paso

#### Paso 1: Solicitud de Reunión
* **Tester:**
  > *"Hola, me gustaría agendar una reunión o videollamada para que me muestren una demostración en vivo del sistema."*
* **Comportamiento Esperado de Yeli:**
  * Confirma el interés y pregunta por el día y franja horaria preferida:
    > *"Con mucho gusto. ¿Qué día te acomodaría mejor y prefieres por la mañana o por la tarde?"*

#### Paso 2: Elección de Franja
* **Tester:**
  > *"Me gustaría este viernes por la tarde, por favor."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Permíteme unos segundos mientras consulto los horarios disponibles en la agenda..."*
  * **Herramienta invocada:** `checkAvailability` con rango amplio de tarde (ej. `13:00` a `18:00`) y offset de huso horario (`-06:00`).
  * **Regla estricta:** Ofrece como **máximo 2 opciones de horario** claras:
    > *"Tengo disponible el viernes a las cuatro de la tarde o a las cinco y media de la tarde, ¿cuál te queda mejor?"*

#### Paso 3: Selección de Horario
* **Tester:**
  > *"El de las cuatro de la tarde me queda perfecto."*
* **Comportamiento Esperado de Yeli:**
  * Solicita los datos de confirmación de uno en uno (o los que falten):
    > *"Perfecto. Para apartar tu espacio, ¿me proporcionas tu nombre completo y tu correo electrónico?"*

#### Paso 4: Aporte de Datos
* **Tester:**
  > *"Mi nombre es Sofía Ramírez y mi correo es sramirez@clinica.mx. Mi teléfono es el 2221234567."*
* **Comportamiento Esperado de Yeli:**
  * Pide que le deletrees el correo o lo repite para confirmar:
    > *"Perfecto, Sofía. Repito tu correo: s-r-a-m-i-r-e-z arroba clinica punto m-x, ¿es correcto?"*

#### Paso 5: Confirmación y Reservación
* **Tester:**
  > *"Sí, es correcto."*
* **Comportamiento Esperado de Yeli:**
  * **Frase de espera:** *"Un segundo mientras reservo tu cita en el calendario..."*
  * **Herramienta invocada:** `bookAppointment` con `startTime`, `customerName`, `customerEmail`, `customerPhone` y `conversationId`.
  * **Cierre estricto:** Repite **solo fecha, hora y correo**, nada más:
    > *"Tu cita ha quedado confirmada para el viernes a las cuatro de la tarde. Te enviamos los detalles a sramirez@clinica.mx. ¿Te puedo apoyar con algo adicional?"*

---

### ✅ Criterios de Éxito
- [✅] Ofreció máximo dos opciones de horario (nunca una lista larga).
- [✅] Formuló una sola pregunta por turno.
- [✅] Confirmó la cita repitiendo únicamente fecha, hora y correo electrónico.
- [✅] Utilizó el huso horario correcto de México (-06:00).

