# API del catálogo de productos — contrato para consumidores

Fuente de verdad del contrato HTTP del módulo de catálogo. `datagol-frontend`
referencia este documento en vez de duplicar shapes de request/response —
cualquier cambio de contrato se hace aquí primero.

Documento hermano de `docs/tasks/catalogo-productos-grupos-cred.md` (el
diseño original de FASE A–G) y `db/schema.md` (esquema completo de tablas).
Este documento cubre exclusivamente lo que un cliente HTTP necesita saber:
rutas, permisos, shapes, y por qué cada una es como es.

---

## 1. Convenciones generales

- **Base de rutas de catálogo:** `/api/organizations/:id/catalogs/...` — `:id` es la organización autenticada (Supabase Auth, `Authorization: Bearer <jwt>`), no el catálogo. Permisos vía `services/permission-service.ts`.
- **Feature gate:** toda ruta bajo `/api/organizations/:id/catalogs/...` y `/api/organizations/:id/credential-group/organizations` exige la feature `product_rag` habilitada (planes `elite`/`enterprise`) — sin ella, `403 { code: 'FEATURE_DISABLED' }` antes de evaluar cualquier otra cosa.
- **Permisos:** `view_catalog` (lectura) y `manage_catalog` (escritura/importación) — ver `src/types/permission-keys.ts`. Un permiso insuficiente devuelve `403 { code: 'PERMISSION_DENIED', requiredPermission }`.
- **Pertenencia a catálogo:** rutas con `:catalogId` verifican `catalog_access` explícitamente (la tabla, no RLS — estas rutas usan `supabaseAdmin`/`service_role`, que bypasea RLS por diseño; AGENTS.md §16). Sin acceso: `404` (nunca revela que el catálogo existe).
- **Pertenencia a producto:** rutas con `:productId` además verifican `products.catalog_id = :catalogId`. Sin pertenencia: `404`.
- **Envoltura de respuesta:** todo 2xx trae `{ success: true, data: ... }`; todo error trae `{ success: false, error: string, code?, message?, requiredPermission? }`. Los shapes de `data` están definidos con Zod en `src/schemas/catalog.ts` y se validan antes de responder (`.parse()`), así que el shape documentado aquí es siempre el shape real.
- **Multipart:** los tres endpoints de importación (`inspect`, `preview`, `import`) reciben `multipart/form-data`. `inspect` solo lee el campo `file`; `preview`/`import` además leen los campos de texto `mode` y `columnMapping` (JSON serializado como string).

Implementación: `src/routes/catalogs.ts` (rutas), `src/schemas/catalog.ts` (Zod), `src/services/catalog-import-service.ts` y `src/services/product-image-service.ts` (lógica).

---

## 2. Catálogos

### `POST /api/organizations/:id/catalogs`
Crea un catálogo. Permiso: `manage_catalog`.

Body: `{ name: string, description?: string }`
`201 { success: true, data: { id, name, description, created_at } }`

### `GET /api/organizations/:id/credential-group/organizations`
Organizaciones hermanas del mismo `credential_group_id`, excluyendo a `:id` — para elegir con quién compartir un catálogo o a cuál fijarle un override de precio. Permiso: `manage_catalog`.

**Por qué existe:** la RLS de `organizations` (`org_read`, migración 45) solo deja ver `id IN (auth_active_organization_ids())` — un admin/owner normal no puede hacer un `SELECT` directo y listar a sus hermanas de grupo. Este endpoint resuelve el grupo con `supabaseAdmin` y lista explícitamente.

`200 { success: true, data: [{ id: string, name: string }] }` (ordenado por `name`)

### `POST /api/organizations/:id/catalogs/:catalogId/share`
Comparte un catálogo con otra organización. Permiso: `manage_catalog`, requiere `can_edit` sobre el catálogo (o ser el owner).

Body: `{ organizationId: string (uuid), canEdit?: boolean (default false) }`
`200 { success: true }`

**Restricción de grupo:** el trigger `enforce_catalog_share_scope` (migración 56) rechaza compartir con una organización fuera del `credential_group_id` del owner del catálogo. La ruta traduce esa excepción de Postgres a `400 { error: 'Solo se puede compartir un catálogo con organizaciones del mismo grupo de credenciales.' }` — nunca deja pasar el error crudo del trigger.

---

## 3. Importación (wizard de 4 pasos)

Flujo pensado para el frontend: **Paso 1** (selección de archivo/modo, 100% cliente) → **Paso 2** `/import/inspect` (mapeo de columnas) → **Paso 3** `/import/preview` (confirmación) → **Paso 4** `/import` (aplicar). Los tres endpoints de red comparten permiso `manage_catalog` + `can_edit` sobre el catálogo.

CSV y XLSX se parsean siempre en el backend (`parseCatalogFile`, `services/catalog-import-service.ts`) — nunca en el navegador (regla de proyecto, AGENTS.md §1).

### `POST /api/organizations/:id/catalogs/:catalogId/import/inspect`
Multipart: **solo** el campo `file` (sin `mode` ni `columnMapping` — detectar encabezados no depende de ninguno de los dos).

**Por qué existe:** problema de huevo y gallina — el Paso 2 necesita mostrarle al usuario los encabezados reales del archivo para que arme `columnMapping`, pero `/import/preview` exige `columnMapping` ya armado y válido. `inspect` es el paso previo: solo detecta, nunca calcula altas/cambios/errores.

`200 { success: true, data: { headers: string[], sampleRows: Record<string,string>[], totalRows: number } }`
`sampleRows` son las primeras 5 filas (constante `IMPORT_INSPECT_SAMPLE_ROWS` en `routes/catalogs.ts`), para que el usuario vea contexto real al mapear.

### `POST /api/organizations/:id/catalogs/:catalogId/import/preview`
Multipart: `file` + campos de texto `mode` (`completo` | `solo_precios`) y `columnMapping` (JSON, ver §3.1).

Vista previa sin escribir nada en la base — cuenta altas, cambios y errores con la misma lógica pura que `/import` (`buildImportPlan`), para que preview y apply nunca diverjan.

`200 { success: true, data: { totalRows, toCreate, toUpdate, errors: ImportRowError[], duplicateSkusInFile: string[], imageErrors: ImportRowError[] } }`

`imageErrors` siempre llega `[]` en preview (no se descargan imágenes en este paso) — existe en el shape solo para que sea idéntico al de `/import` y el frontend no tenga que distinguir entre los dos casos.

### `POST /api/organizations/:id/catalogs/:catalogId/import`
Mismo multipart que preview. Aplica el plan contra la base, registra la corrida en `catalog_imports`.

`200 { success: true, data: { importId, status: 'completado'|'fallido', rowsTotal, rowsCreated, rowsUpdated, rowsFailed, errors: ImportRowError[], imageErrors: ImportRowError[] } }`

`ImportRowError = { row: number, message: string }` — `row` es el número de fila del archivo (1 = encabezado, así que la primera fila de datos es `2`).

**`errors` vs. `imageErrors` — distinción deliberada:**
- `errors`: fallos que invalidan la fila (SKU faltante, nombre faltante en modo `completo`, precio no numérico, SKU duplicado dentro del archivo, SKU inexistente en modo `solo_precios`). La fila **no** se crea ni actualiza.
- `imageErrors`: fallos al descargar/validar la imagen de la columna opcional `imageUrl`. **Nunca invalidan la fila** — el producto/variante ya se creó o actualizó antes de intentar la imagen. Ejemplo de mensaje: `No se pudo descargar la imagen del SKU "ARN-GEL-060": <motivo>`.

**Descarga de `imageUrl` — guard SSRF:** protocolo `http`/`https` únicamente; se rechaza `localhost` y cualquier hostname que resuelva (vía DNS real) a loopback/enlace-local/rango privado (`10.x`, `172.16–31.x`, `192.168.x`, `127.x`, `169.254.x`, y sus equivalentes IPv6). Timeout de 10 s, tope de descarga de 10 MB (antes de aplicar el límite real de imagen, ver §5). La imagen descargada pasa por la misma validación de magic bytes que la subida manual.

**Modo `solo_precios`:** si `columnMapping.imageUrl` viene mapeada, se ignora — este modo no toca la capa descriptiva del producto (regla de diseño: un archivo de dos columnas, SKU y precio, nunca dispara resincronización de KB ni cambios de imagen).

### `GET /api/organizations/:id/catalogs/:catalogId/imports`
Historial de corridas de importación. Permiso: `view_catalog`.

`200 { success: true, data: [{ id, fileName, mode, status, rowsTotal, rowsCreated, rowsUpdated, rowsFailed, createdAt, completedAt }] }`

---

### 3.1 `columnMapping` (`ColumnMapping`)

Cada clave canónica apunta al **encabezado real** que trae el archivo del cliente (nunca al revés) — cada cliente trae un formato de columnas distinto y no se le pide reformatear su archivo.

```ts
{
  sku: string;                  // obligatorio en ambos modos
  name?: string;                // obligatorio en modo "completo"
  category?: string;
  activeComponents?: string;
  suggestedUse?: string;
  description?: string;
  contraindications?: string;
  presentation?: string;
  price?: string;               // obligatorio en modo "solo_precios"
  stockStatus?: string;         // valores: ver §6 STOCK_STATUSES
  stockNote?: string;
  imageUrl?: string;            // opcional en modo "completo"; ignorada en "solo_precios"
}
```

### 3.2 Mapeos de columnas guardados

Un cliente reimporta con el mismo formato de archivo mes a mes — estos endpoints evitan repetir el mapeo manual en cada corrida. Tabla `catalog_import_mappings` (migración 61).

**`GET /api/organizations/:id/catalogs/:catalogId/import-mappings`** — Permiso `view_catalog`.
`200 { success: true, data: [{ id, name, mode, columnMapping, createdAt }] }` (orden: más reciente primero)

**`POST /api/organizations/:id/catalogs/:catalogId/import-mappings`** — Permiso `manage_catalog`.
Body: `{ name: string, mode: 'completo'|'solo_precios', columnMapping: ColumnMapping }`
`201 { success: true, data: { id, name, mode, columnMapping, createdAt } }`

No participa en la aplicación del import — solo precarga `columnMapping` en el formulario del wizard.

---

## 4. Imágenes de producto

Bucket privado `product-images` en Supabase Storage (`services/product-image-service.ts`). Nunca se expone `image_path` tal cual — todo endpoint devuelve una **URL firmada** (expira en 1 hora).

### Límite: PNG / JPEG / WebP, 5 MB
Validado por magic bytes (`src/lib/magic-bytes.ts`, `validateImageMagicBytes`), nunca por extensión ni `Content-Type` declarado por el cliente. `MAX_PRODUCT_IMAGE_SIZE_BYTES = 5 * 1024 * 1024`.

### `POST /api/organizations/:id/catalogs/:catalogId/products/:productId/image`
Multipart: un solo archivo. Permiso: `manage_catalog`. Sube (o reemplaza) la imagen del producto — un producto tiene como máximo una imagen; la anterior se borra de Storage tras confirmar la nueva.

`201 { success: true, data: { imageUrl: string, mimeType: string, sizeBytes: number, uploadedAt: string } }`
Rechazo (formato/tamaño inválido): `400 { success: false, error: string }` — nunca un 500.

### `GET /api/organizations/:id/catalogs/:catalogId/products/:productId/image`
Permiso: `view_catalog`. Re-firma la URL sin tener que volver a subir la imagen.

`200 { success: true, data: { imageUrl: string|null, mimeType: string|null, sizeBytes: number|null, uploadedAt: string|null } }` — todo `null` si el producto no tiene imagen (nunca 404 por esto).

### `DELETE /api/organizations/:id/catalogs/:catalogId/products/:productId/image`
Permiso: `manage_catalog`. Idempotente: un producto sin imagen devuelve `200` igual.

### `POST /api/organizations/:id/catalogs/:catalogId/products/images/batch`
Firma en un solo viaje las imágenes de **varios** productos. Permiso: **`view_catalog`** (deliberadamente más laxo que el resto de endpoints de imagen — es solo lectura).

**Por qué existe:** una lista/tabla de productos con miniaturas no debe firmar imágenes una por una (N llamadas) ni firmar todo el catálogo de una vez (asumir que "una tabla firma solo lo visible en pantalla" es la razón central del endpoint).

Body: `{ productIds: string[] }` — 1 a 100 UUID (`MAX_BATCH_IMAGE_PRODUCT_IDS`). Más de 100: `400`.

`200 { success: true, data: { images: Record<productId, { imageUrl, mimeType, sizeBytes, uploadedAt }> } }`

Un `productId` que no pertenece al catálogo, o sin imagen, aparece igual en el mapa con `imageUrl: null` — nunca se omite la clave, nunca truena por un id suelto.

---

## 5. Tool del agente — `POST /tools/:webhookToken/products`

Camino crítico de voz (`src/routes/tools/products.ts`) — **no** vive bajo `/api/organizations/...`, se autentica con `x-tool-secret` + `webhookToken` de la ruta (igual que el resto de `routes/tools/**`). Presupuesto contractual: **p95 < 300 ms**.

Body: `{ skus: string[] }` (se procesan como máximo los primeros 3, sin rechazar el resto — un 400 no es verbalizable por el agente).

`200 { results: ProductResult[], message?: string }`

```ts
ProductResult = {
  sku: string;
  found: boolean;
  presentation?: string | null;
  price?: number | null;
  currency?: string | null;
  priceIncludesTax?: boolean | null;
  availabilityText?: string | null;   // ya matizado, ver tabla abajo — nunca una cifra
  imageUrl?: string | null;
}
```

Resuelve contra `resolve_variant_for_org(p_org_id, p_sku)` (override de sucursal > precio de catálogo). Nunca devuelve campos internos (`id`, `productId`, `variantId`).

**`imageUrl`:** el agente de **voz** no puede usarla (canal de audio); los canales de **texto** (WhatsApp) sí. El backend la incluye siempre en el resultado — es el mismo webhook para ambos canales, e inofensiva cuando el consumidor es voz; es la capa de mensajería la que decide mostrarla, no una bifurcación en este endpoint ni en el RPC. Firmar la URL es una llamada extra a Storage que el presupuesto p95<300ms no contemplaba, así que se acota a 200 ms (`Promise.race`) — si no llega a tiempo, `imageUrl` sale `null` en vez de retrasar precio/disponibilidad.

**Mapeo `stock_status` → `availabilityText`** (nunca "sí tenemos" ni una cifra de existencias — las existencias son informativas, no inventario en vivo):

| `stock_status` | Texto |
|---|---|
| `disponible` | "Según mi información hay disponible, aunque conviene confirmarlo" |
| `bajo` | "Me aparece con poca existencia" |
| `agotado` | "Me aparece agotado" |
| `bajo_pedido` | "Es sobre pedido" |
| `sin_dato` | "No tengo la disponibilidad a la mano" |

Degradación: feature deshabilitada o error inesperado → `200 { results: [], message: '...' }` — nunca un 500 mudo (el agente necesita algo verbalizable).

---

## 6. Enums / constraints (única fuente de verdad en código)

- `product_variants.stock_status` / `organization_variant_overrides.stock_status` → `src/types/stock-status.ts` (`disponible`, `bajo`, `agotado`, `bajo_pedido`, `sin_dato`)
- `catalog_imports.mode` → `src/types/catalog-import.ts` (`completo`, `solo_precios`)
- `catalog_imports.status` → `procesando`, `completado`, `fallido`, `revertido`
- Permisos → `src/types/permission-keys.ts` (`view_catalog`, `manage_catalog`)
- Feature → `src/types/feature-taxonomy.ts` (`product_rag`)

Verificados por inserción directa contra la base real en `__tests__/catalog-enums.test.ts` — si un valor de esta lista se desincroniza del `CHECK` constraint real, esa prueba falla.

---

## 7. Migraciones relevantes

| Migración | Qué agrega |
|---|---|
| `56_catalogo_productos.sql` | Esquema base completo: `catalogs`, `catalog_access` (+ trigger `enforce_catalog_share_scope`), `products`, `product_variants`, `variant_price_history`, `organization_variant_overrides`, `product_kb_sync`, `catalog_imports`; función `resolve_variant_for_org` (versión original, sin `image_path`); feature `product_rag` + permisos `view_catalog`/`manage_catalog`; RLS de todas las tablas anteriores. |
| `57_credential_group_webhook_token.sql` | Webhook con workspace compartido — fuera del alcance directo del catálogo, pero comparte el modelo de `credential_group_id`. |
| `58_catalog_kb_folder.sql` | `catalogs.kb_folder_id` — una carpeta de KB de ElevenLabs por catálogo (resuelta perezosamente por el job de sincronización, no por esta migración). |
| `59_fix_variant_price_history_trigger.sql` | Corrección del trigger que registra `variant_price_history` al cambiar `product_variants.price`. |
| `60_product_image.sql` | `products.image_path`, `image_mime_type`, `image_size_bytes`, `image_uploaded_at` — soporte de imagen de producto (bucket `product-images`). |
| `61_catalog_import_mappings.sql` | Tabla `catalog_import_mappings` (mapeos de columnas guardados, §3.2). RLS de solo lectura — la escritura pasa exclusivamente por la API con `supabaseAdmin` + verificación explícita de `manage_catalog`, igual que `catalog_imports`. |
| `62_resolve_variant_image.sql` | `create or replace function resolve_variant_for_org(...)` — agrega `image_path` al `returns table`, para que el tool de productos (§5) pueda construir `imageUrl`. No modifica la 56 ya aplicada (regla de proyecto: nunca tocar una migración aplicada). |

Las migraciones de este proyecto se aplican **a mano** contra el proyecto Supabase real (no hay script de `migrate`) — antes de asumir que un endpoint de este documento funciona en un ambiente dado, confirmar que su migración correspondiente ya se aplicó ahí.

---

## 8. Historial de descubrimiento (contexto, no contrato)

Los endpoints de §3.2, §4 (`.../images/batch`), §2 (`credential-group/organizations`) y el paso `/import/inspect` de §3 no estaban en el diseño original de FASE A–G (`docs/tasks/catalogo-productos-grupos-cred.md`) — surgieron durante la implementación del frontend (`docs/manual-catalogo-productos.md`, `datagol-frontend`) como huecos de contrato entre lo que el wizard/UI necesitaba y lo que ya existía. Se documentan aquí como parte normal del contrato, no como un anexo aparte, porque ya están implementados, probados y en uso.
