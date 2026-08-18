# Fase E — Texto sugerido de prompt: "¿cómo se enteró?"

Entregable de `docs/tasks/asistencia-valor de cierre.md` (Fase E). Documento
puro, sin código: texto para pegar en la configuración del agente de
ElevenLabs (prompt del sistema + criterio de extracción del campo de Data
Collection `como_se_entero`, ver D.1).

## Contexto

El campo `como_se_entero` debe llenarse con **una** de las 9 categorías
canónicas de `src/types/lead-source.ts`:

```
anuncio_pagado, busqueda_google, redes_sociales, referido,
sitio_web, letrero_fisico, directorio, otro, desconocido
```

Si el agente no logra ubicar la respuesta del prospecto en ninguna de estas
categorías, el criterio de extracción debe producir `desconocido` — **nunca**
forzar a la categoría más parecida (regla explícita de D.1). Un dato ausente
es honesto; un dato adivinado contamina las métricas de atribución.

## Fragmento de prompt (sección de recolección de datos)

Agregar como un punto más dentro del bloque donde el agente ya recopila
nombre, motivo de contacto, etc. — mismo tono conversacional, **una sola
pregunta por turno**, sin interrogatorio (mismo criterio que ya rige el resto
del prompt, ver `docs/analisis-integraciones-cal-elevenlabs-maps.md`):

> En algún momento natural de la conversación — después de resolver la
> necesidad principal del prospecto, nunca al inicio ni interrumpiendo — pregunta
> de forma breve y casual cómo llegó a conocer el negocio. Por ejemplo:
> "Oye, y por cierto, ¿cómo supiste de nosotros?" o "¿Cómo nos encontraste?".
>
> No lo preguntes si el prospecto ya lo mencionó espontáneamente en cualquier
> punto anterior de la llamada (por ejemplo, "vi su anuncio en Facebook" o "me
> recomendó un amigo") — en ese caso, usa directamente lo que ya dijo.
>
> Si el prospecto da una respuesta vaga o no la sabe ("no recuerdo", "por ahí
> lo vi"), no insistas ni le ofrezcas opciones para elegir. Una sola vez es
> suficiente; no es información crítica para resolver su solicitud.

## Criterio de extracción del campo `como_se_entero`

Instrucción para el bloque de Data Collection (tipo `string`, no `enum` —
ElevenLabs no fuerza el vocabulario del lado del proveedor, la normalización
estricta ocurre en `extractLeadSource()` del backend):

> Extrae la categoría que mejor describa cómo el prospecto se enteró del
> negocio, usando EXACTAMENTE una de estas palabras, en minúsculas, sin
> acentos ni texto adicional:
>
> - `anuncio_pagado` — mencionó publicidad paga, anuncio patrocinado, Google
>   Ads, Meta Ads, "vi un anuncio".
> - `busqueda_google` — buscó en Google/un buscador de forma orgánica, sin
>   mencionar que era un anuncio.
> - `redes_sociales` — Facebook, Instagram, TikTok, X, LinkedIn, YouTube, sin
>   mencionar que era un anuncio pagado.
> - `referido` — un amigo, familiar, conocido u otro cliente se lo recomendó.
> - `sitio_web` — visitó el sitio web del negocio directamente.
> - `letrero_fisico` — vio un letrero, anuncio espectacular, volante o
>   publicidad física en la calle o el local.
> - `directorio` — lo encontró en Google Maps, páginas amarillas o un
>   directorio similar.
> - `otro` — mencionó una fuente que no encaja en ninguna categoría anterior
>   pero es clara y verificable (por ejemplo, una feria o evento).
> - `desconocido` — no se preguntó, no respondió con claridad, o su respuesta
>   es ambigua.
>
> Si tienes cualquier duda sobre cuál categoría aplica, usa `desconocido`. No
> elijas la categoría que te parezca más cercana — un dato incorrecto es peor
> que un dato ausente.

## Pendiente fuera de este repositorio

Este texto debe pegarse manualmente en el dashboard de ElevenLabs:

1. Agregar el fragmento de prompt a la sección de recolección de datos del
   agente.
2. Crear el campo `como_se_entero` (tipo `string`) en la configuración de
   Data Collection del agente, con el criterio de extracción de arriba.

Sin este paso manual, `src/services/call-payload-mapper.ts` seguirá buscando
la clave `como_se_entero` en el payload post-call pero nunca la encontrará
(el mapeo ya está implementado y listo del lado del backend, D.1).
