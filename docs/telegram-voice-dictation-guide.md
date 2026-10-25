# Guía Paso a Paso: Dictado por Voz en Telegram para Android (Gboard) e iOS (iPhone)

El Bot Ejecutivo de Datagol en Telegram procesa tus preguntas como **texto estructurado** (`message.text`), respetando la arquitectura de seguridad y latencia del sistema (el backend no almacena ni retransmite archivos de audio `.ogg` de notas de voz).

Para hablarle al Bot con tu voz y que la pregunta se envíe automáticamente como texto (a **costo $0** y con transcripción instantánea en tu dispositivo), debes usar el **Micrófono del Teclado** de tu celular (Android Gboard o Dictado de iOS), **NO** el botón de nota de voz de Telegram.

---

## ⚠️ Diferencia Crucial: ¿Cuál micrófono debo presionar?

En la pantalla de chat de Telegram verás **dos iconos de micrófono**:

1. ❌ **Micrófono de Telegram (al lado del clip 📎, en la barra de mensaje de Telegram):**
   - Envía un archivo de audio (`.ogg` / nota de voz). El Bot responderá pidiéndote que envíes tu pregunta en texto.
2. ✅ **Micrófono del Teclado (en la barra superior del teclado en Android, o en la esquina inferior derecha en iPhone):**
   - Convierte tu voz en texto en tiempo real directamente dentro de la caja de escritura, permitiéndote revisar la pregunta y pulsar **Enviar (✈️)**.

---

## 🤖 Parte 1: Cómo Activar y Usar Gboard (Dictado por Voz) en Android

### Paso 1: Verificar o Instalar Gboard (Teclado de Google)
La mayoría de los teléfonos Android (Motorola, Xiaomi, Pixel, OPPO, etc.) ya traen **Gboard** instalado de fábrica. Si usas Samsung o no lo tienes activo:
1. Abre **Google Play Store** y busca **"Gboard - el teclado de Google"**.
2. Si no está instalado, pulsa **Instalar** y ábrelo.

### Paso 2: Establecer Gboard como tu Teclado Predeterminado
1. En tu teléfono Android, abre **Ajustes (Configuración) ⚙️**.
2. Entra en **Sistema** → **Teclado** (en Samsung: **Administración general** → **Lista de teclados y predeterminado**).
3. Toca **Teclado en pantalla** (o **Teclado predeterminado**) y selecciona **Gboard**.

### Paso 3: Activar el "Dictado por Voz" dentro de Gboard
1. En **Ajustes ⚙️** → **Sistema** → **Teclado** → **Teclado en pantalla**, toca **Gboard**.
2. Entra en **Dictado por voz**.
3. Activa el interruptor **Usar dictado por voz**.
4. *(Opcional — Recomendado para mayor velocidad):* Activa **Reconocimiento de voz sin conexión** descargando el paquete de **Español (México)** para que transcriba al instante incluso con poca señal.

### Paso 4: Cómo dictarle una pregunta al Bot en Telegram (Android)
1. Abre **Telegram** y entra al chat con el Bot de tu organización (ej. `@datagolmx_bot`).
2. Toca el campo **"Mensaje"** para que se despliegue el teclado Gboard.
3. En la **barra superior del teclado Gboard** (justo arriba de las letras `O` y `P`), toca el **icono del micrófono 🎙️ del teclado**.
4. Habla con naturalidad, por ejemplo:
   > *"¿Tenemos prospectos pendientes de atender?"* o *"¿Cuántas citas tuvimos esta semana?"*
5. Verás cómo las palabras se escriben solas en el cuadro de texto.
6. Presiona el botón azul **Enviar (✈️)** de Telegram.

---

## 🍎 Parte 2: Cómo Activar y Usar el Dictado por Voz en iOS (iPhone / iPad)

### Paso 1: Activar "Dictado" en la Configuración del iPhone
1. Abre la app **Configuración (Ajustes) ⚙️** en tu iPhone.
2. Entra en **General** → **Teclado**.
3. Desplázate hacia abajo y activa el interruptor **Activar dictado** (confirma en *Activar dictado* si aparece un aviso).
4. En **Idiomas de dictado**, asegúrate de que esté marcado **Español (México)**.

### Paso 2: Cómo dictarle una pregunta al Bot en Telegram (iPhone)
1. Abre **Telegram** y entra al chat con el Bot de tu organización.
2. Toca el campo **"Mensaje"** para que aparezca el teclado de iOS.
3. Toca el **icono del micrófono 🎙️ ubicado en la esquina inferior derecha del teclado** (debajo de la tecla *Intro / Buscar*, **no** el micrófono junto al icono de sticker/clip de Telegram).
4. Di tu pregunta en voz alta, por ejemplo:
   > *"¿Tenemos correos electrónicos pendientes?"*
   *(Tip: en iOS puedes decir "signo de interrogación" o simplemente hablar normal; el asistente entiende la pregunta con o sin signos).*
5. Una vez que el texto aparezca escrito en la barra de mensaje, pulsa el botón **Enviar (⬆️ / ✈️)**.

---

## 🔧 Solución Rápida de Problemas

| Problema | Causa y Solución |
| :--- | :--- |
| **El Bot responde:** *"Por favor envía una pregunta en texto..."* | Presionaste el micrófono de **nota de voz de Telegram** en lugar del micrófono de **tu teclado**. Toca primero dentro de la caja de texto "Mensaje" para abrir el teclado y usa el micrófono del teclado. |
| **No aparece el micrófono en la barra superior de Gboard (Android)** | En el teclado Gboard, toca los **4 cuadritos** (esquina superior izquierda del teclado) o los **3 puntos `...`**, busca **Dictado por voz** y arrástralo a la barra superior, o verifica que la app **"Google"** tenga permiso de **Micrófono** en `Ajustes → Aplicaciones → Google → Permisos`. |
| **El micrófono de Gboard dice "Sin permiso para grabar audio"** | Ve a `Ajustes → Aplicaciones → Gboard → Permisos → Micrófono` y selecciona **Permitir solo con la app en uso**. |
