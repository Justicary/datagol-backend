# TASK — Catálogo de productos y grupos de credenciales (BACKEND)

**Proyecto:** `datagol-backend`
**Precondición:** `56_catalogo_productos.sql`, bloques 1–12, aplicada. El bloque 13 (plano de control) queda pendiente y no es dependencia de esta tarea.
**Referencia obligatoria:** `AGENTS.md` de este repositorio

---

## Las dos reglas que gobiernan el diseño

**1. El precio nunca va a la knowledge base.** La KB es un índice precalculado; un precio ahí queda congelado el día que se indexó. Un agente cotizando $480 cuando cuesta $720 no cometió un error de software: comprometió al negocio del cliente frente a un consumidor.

**2. Las existencias son informativas.** No es inventario en vivo. El agente debe matizarlas siempre.

De la primera regla se desprende el beneficio central: como el precio no está en la KB, **un cambio de precio no dispara resincronización**. Los precios cambian semanalmente; las descripciones, un par de veces al año.

---

## FASE A — Módulos de constraint

Patrón de `secret-keys.ts`, con prueba de inserción contra la base real:

- `product_variants.stock_status`: `disponible`, `bajo`, `agotado`, `bajo_pedido`, `sin_dato`
- `product_kb_sync.status`: `pendiente`, `sincronizado`, `error`, `eliminado`
- `catalog_imports.mode` / `.status`
- `elevenlabs_plans.key`: `creator`, `pro`, `scale`, `business`
- Permisos nuevos: `view_catalog`, `manage_catalog`

Cero literales fuera de estos módulos.

---

## FASE B — Grupos de credenciales

Toda organización pertenece ya a un grupo (el backfill creó uno por organización existente). Ahora hay que usarlo.

### B.1 Resolución de secretos

`getSecret(organizationId, key)` debe resolver **contra la organización dueña del grupo**, no contra la organización que pregunta. En un grupo de uno el comportamiento es idéntico al actual.

### B.2 Rotación restringida

Solo el `owner` de `credential_groups.owner_organization_id` puede rotar las llaves compartidas. **Rotar una llave compartida tumba a todo el grupo**, así que el resto de las organizaciones las ve en solo lectura, con nota de quién las administra.

### B.3 Webhook con workspace compartido

Con un workspace para varias sucursales llega **un solo secreto de firma**. La resolución cambia a dos pasos:

1. `webhook_token` de la ruta → resuelve el **grupo de credenciales**
2. Verificar la firma con el secreto del grupo → autentica el origen
3. **Solo entonces** leer `agent_id` del payload → resuelve la organización

El orden importa: nunca se lee el cuerpo antes de autenticarlo. Si el `agent_id` no corresponde a ninguna organización del grupo, rechazar y registrar.

`organizations.elevenlabs_agent_id` ya tiene índice único; el mapeo es directo.

**Compatibilidad:** las instalaciones de un solo inquilino siguen funcionando igual. El grupo de uno hace que el camino sea el mismo.

### B.4 Concurrencia

- Registrar el asiento de `agent_minute_burst` cuando `metadata.charging.is_burst` sea verdadero. La tarifa ya existe en `provider_rates` y es el doble.
- Job que avise cuando una organización rebase su cuota blanda de `organization_concurrency_quota`. **Nunca rechazar una llamada por cuota** — es visibilidad, no un límite.
- Exponer `v_concurrency_allocation`.

**Por qué importa:** en un grupo compartido, si la sucursal A satura el pozo un viernes, la sucursal B paga burst por llamadas que no causó. Sin atribución, ese sobrecosto es imposible de repartir.

---

## FASE C — Sincronización con la knowledge base

### C.1 Generación del documento

Un documento por producto, texto plano en español, con el SKU al inicio y al final:

```
SKU: ARN-GEL-060

Gel de árnica 60 ml
Categoría: Analgésicos tópicos
Componentes activos: árnica montana al 10%, mentol, alcanfor
Uso sugerido: aplicar sobre la zona adolorida dos o tres veces al día.
Indicado para dolor muscular, golpes e inflamación de rodilla.
Contraindicaciones: no aplicar sobre heridas abiertas.
Presentaciones: 60 ml, 120 ml.

Para precio y disponibilidad, consultar SKU ARN-GEL-060.
```

La última línea es deliberada: instruye al agente a usar el tool en vez de inventar.

**Verificación obligatoria en pruebas:** el documento generado **no contiene precio ni cantidad de existencias**. Es la regla número uno del módulo y debe fallar la suite si se rompe.

### C.2 Job de sincronización

1. Leer los productos con `status` en `pendiente` o `error` desde `product_kb_sync`
2. Agrupar con retraso (evitar reindexar 400 veces durante una importación)
3. Crear o actualizar el documento vía la API de knowledge base de ElevenLabs
4. **Recalcular el índice RAG** — es un paso asíncrono aparte; sin él el documento existe pero no se recupera
5. Guardar `kb_document_id`, hash del contenido y marcas de tiempo
6. Ante error: `status = 'error'`, incrementar `attempts`, retroceso exponencial

**Usar una carpeta por catálogo.** El agente siempre accede a las carpetas mediante RAG y nunca las coloca en el prompt, así que la carpeta garantiza el modo correcto sin depender de la configuración por documento.

Producto desactivado o borrado → eliminar el documento y marcar `eliminado`.

### C.3 Verificar límites antes de prometer

El tamaño total indexable para RAG depende del plan de suscripción. Un catálogo de 5,000 productos son 5,000 documentos.

**Consulta el tamaño actual de la KB antes de sincronizar** y reporta cuando se acerque al límite. Si el límite aprieta, la salida es consolidar por categoría, con recuperación menos precisa — pero eso se decide con datos, no de antemano.

---

## FASE D — Tool del agente

```
POST /tools/:webhookToken/products
```

Recibe uno o varios SKU. Resuelve la organización igual que los demás tools, llama a `resolve_variant_for_org` y devuelve precio y disponibilidad vigentes.

**Presupuesto: p95 < 300 ms.** Es un `SELECT` por índice único, así que debe sobrar. Si no sobra, algo está mal.

### Formato de respuesta

Pensado para verbalizarse, no para leerse:

- Precio con moneda y si incluye IVA
- Presentación
- Disponibilidad **como texto matizado**, nunca como afirmación categórica
- Nunca devolver campos internos ni identificadores

### Mapeo de `stock_status` a lenguaje hablado

| Valor | Lo que dice el agente |
|---|---|
| `disponible` | "Según mi información hay disponible, aunque conviene confirmarlo" |
| `bajo` | "Me aparece con poca existencia" |
| `agotado` | "Me aparece agotado" |
| `bajo_pedido` | "Es sobre pedido" |
| `sin_dato` | "No tengo la disponibilidad a la mano" |

Esto va en el mapeo del backend y reforzado en el system prompt. **Nunca "sí tenemos" ni "hay 12 piezas".**

### Degradación

Si el tool falla, respuesta verbalizable: *"No puedo consultar el precio en este momento, ¿le tomo sus datos y le confirmamos?"*. Nunca un 500 mudo.

---

## FASE E — Importación

```
POST   /organizations/:id/catalogs
POST   /organizations/:id/catalogs/:catalogId/import/preview
POST   /organizations/:id/catalogs/:catalogId/import
GET    /organizations/:id/catalogs/:catalogId/imports
POST   /organizations/:id/catalogs/:catalogId/share
```

- CSV y XLSX **en el backend**. Nunca procesar el archivo en el navegador.
- **Mapeo de columnas configurable.** Cada cliente trae un formato distinto y nadie va a reformatear su archivo. Es el paso que decide si la feature es usable.
- Vista previa antes de aplicar: altas, cambios y errores contados.
- Deduplicación por SKU dentro del catálogo, sin distinguir mayúsculas.
- **Modo `solo_precios`:** archivo de dos columnas (SKU y precio). No toca la capa descriptiva y **no dispara resincronización de la KB**.
- Registro en `catalog_imports` con conteos y errores por fila.
- Compartir catálogo solo dentro del mismo grupo — el trigger de la base ya lo impide; la API debe devolver un mensaje claro, no un error de constraint.

---

## FASE F — Permisos y entitlement

- Feature `product_rag`, planes `elite` y `enterprise`
- `view_catalog` para consultar, `manage_catalog` para editar e importar
- **`service_role` hace bypass de RLS:** toda consulta con `supabaseAdmin` debe verificar permiso y pertenencia al catálogo explícitamente
- El tool del agente resuelve el catálogo por la organización, nunca por un parámetro del payload

---

## FASE G — System prompt

Reporta el texto sugerido para que el agente:

- Use el tool antes de mencionar cualquier precio
- **Nunca invente ni recuerde precios** de turnos anteriores de la conversación
- Matice la disponibilidad según el mapeo de la Fase D
- Ofrezca máximo dos o tres productos por turno, como con los horarios
- Diga el precio en palabras naturales, no leyendo cifras crudas

---

## Pruebas

- **La central:** el documento generado para la KB no contiene precio ni existencias
- Un cambio de precio **no** marca el producto para resincronización
- Un cambio de descripción **sí** lo marca
- El tool resuelve el override de la sucursal cuando existe y el precio del catálogo cuando no
- Webhook con workspace compartido: la firma se verifica antes de leer el cuerpo
- `agent_id` que no pertenece al grupo se rechaza
- Compartir catálogo con una organización de otro grupo se rechaza
- SKU duplicado en la importación se detecta en la vista previa
- Importación en modo `solo_precios` no marca nada para sincronizar
- Un `member` recibe 403 al importar
- Burst se registra con la tarifa doble
- Cada rechazo con su contraparte de éxito