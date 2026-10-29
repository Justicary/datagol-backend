# TASK — Sistema de cotizaciones con carrito conversacional (BACKEND)

**Proyecto:** `datagol-backend`
**Tarea hermana:** `mi-new-app/docs/tasks/procedimiento-cotizaciones-frontend.md`
**Feature nueva:** `quotations` (planes `pro`, `elite`, `enterprise`; `starter` denegado)
**Precondición:** `56_catalogo_productos.sql` a `63_catalog_custom_fields.sql` aplicadas (catálogo, variantes, overrides de sucursal, campos personalizados).
**Migraciones nuevas:** `76_catalog_item_types_and_plans_bridge.sql` y `77_quotations.sql` (confirmar al implementar que siguen siendo los siguientes números libres; nunca editar una migración ya aplicada).
**Referencia obligatoria:** `AGENTS.md` de este repositorio — §3 (latencia), §4 (idempotencia), §5 (multi-tenancy), §6 (metering), §8 (colas), §9–§10 (pruebas y mutación), §16 (entitlements).
**Fecha de análisis:** 2026-10-26 · **Revisión 2:** decisiones del responsable de producto incorporadas (ver "Decisiones resueltas").

---

## Objetivo

Que el agente de voz/chat de una PyME pueda, durante la conversación:

1. Buscar productos, servicios o planes del catálogo de la organización.
2. Ir armando un **carrito por contacto**: agregar partidas, cambiar cantidades, eliminar partidas, repasar el contenido — y retomarlo en una conversación posterior, incluso por otro canal.
3. Al terminar, **emitir una cotización con folio** y enviar el PDF por **correo electrónico y/o WhatsApp**.


La cotización conserva **folio, IDs de producto/variante y snapshot de precios e impuestos**, de forma que en el futuro pueda convertirse en **nota de remisión o factura (CFDI)**, o exportarse al sistema administrativo del cliente ó alguna API.
Como prerrequisito, el catálogo aprende a distinguir **producto (inventariable) / servicio / plan** y **pago único / mensual / anual** (`billing_period`, mismo dominio que ya usa `deployments`), y los planes de que actualmente tiene definidos el tenant Datagol en la tabla `plans`, mismos que se proyectan automáticamente al catálogo sin romper la landing que hoy los lee en tiempo real.

---

## Decisiones resueltas

| # | Decisión | Resolución |
|---|---|---|
| D1 | Planes en el catálogo | Los planes (de Datagol o los que defina cualquier tenant) viven en el catálogo como partidas cotizables. Para Datagol, `plans` sigue siendo la fuente de verdad y se **proyecta** al catálogo (Fase B2). Un tenant define sus planes directamente en su catálogo con `item_type = 'plan'`. |
| D2 | Llave del carrito | **Por contacto**: un solo borrador abierto por `(organization_id, contact_id)`. `conversation_id` se guarda como dato de trazabilidad, no como llave. |
| D3 | Retención | La purga por `retention_days` **solo borra cotizaciones en estado `abandonada`**. Nada más se purga: emitidas, enviadas, aceptadas, rechazadas, vencidas, canceladas y convertidas se conservan. |
| D4 | Etapa de pipeline `cotizado` | **No en v1.** Se documenta como evolución futura (ver "Evolución futura"). |

---

## Las reglas que gobiernan el diseño

**1. El LLM elige; no calcula ni fija precios.** El agente solo dice *qué* SKU y *cuántas* unidades. Precio, impuestos, subtotales y total los calcula el servicio puro y regresan formateados para voz (`spokenTotal`). Misma regla que `docs/natural-language-reports.md` ("el LLM traduce, no consulta") y `catalogo-productos-grupos-cred.md` ("el precio nunca va a la KB"). **El agente nunca aplica descuentos**: solo un humano desde el dashboard.

**2. El carrito *es* una cotización en borrador, y pertenece al contacto.** No hay tabla de carrito aparte. El folio **nace al emitir** — los carritos abandonados no consumen folios ni dejan huecos.

**3. Emitida = inmutable.** Ni cabecera ni partidas se modifican tras emitir (lo garantiza un trigger). Corregir produce una **revisión nueva** (`COT-2026-000123-R1`).

**4. Snapshot + IDs estables.** Cada partida guarda `variant_id`, `product_id`, `catalog_id`, `external_id`, claves SAT, tipo de partida y modalidad de cobro, **y** una copia de nombre, presentación, precio, moneda y tasa al emitir.

**5. Ningún tercero dentro del tool call.** PDF, Storage, Resend/SMTP/Meta: todo en pg-boss. El tool de emisión responde en < 300 ms con el folio (§3).

**6. Una sola fuente de verdad por dato.** El precio de un plan de Datagol se edita en `plans` y solo ahí; el catálogo es una proyección de solo lectura en esos campos, bloqueada **en base de datos** (el frontend escribe el catálogo directo vía Supabase, así que un bloqueo solo en el backend no basta).

---

## Hallazgos del análisis (estado actual del sistema)

| # | Hallazgo | Ubicación | Impacto | Fase |
|---|---|---|---|---|
| H1 | **Todo el módulo de catálogo está detrás de `product_rag`** (`elite`/`enterprise`). Un tenant `pro` con `quotations` no podría cargar su catálogo. | `src/routes/catalogs.ts:87` (`authorizeOrg`), `src/routes/tools/products.ts:66`; frontend: `DashboardShell.tsx:77`, `dashboard/catalog/page.tsx:83`, `catalog/precios/page.tsx:58` | Bloqueante | B |
| H2 | El job de KB **no verifica ninguna feature** antes de crear documentos en ElevenLabs. Al abrir el catálogo a `pro`, todo tenant `pro` sincronizaría productos a su KB; también ocurre hoy si un tenant baja de `elite`. | `src/jobs/sync-catalog-kb.ts:140` | Alto (§16) | B |
| H3 | `resolve_variant_for_org` hace `LIMIT 1` **sin `ORDER BY`**; el SKU es único por catálogo, no por organización. Resolución no determinista con catálogos compartidos. | `db/migrations/56_catalogo_productos.sql:389-422` (+ `62_resolve_variant_image.sql`) | Medio | B |
| H4 | **Sin `product_rag` el agente no conoce los SKU** (hoy se los da la KB). Hace falta un tool de búsqueda léxica. | `src/routes/tools/products.ts` | Bloqueante para `pro` | D |
| H5 | `dispatchOrSaveDraft` no acepta adjuntos, aunque `email_outbox.attachments` existe. | `src/services/email/email-dispatch.service.ts:12-21` | Medio | F |
| H6 | Envío por Resend con adjunto (tope 7 MB) ya existe. | `src/services/email.ts:520-541` | Reutilización | F |
| H7 | **No existe envío de documentos por WhatsApp** (solo plantillas de texto). | `src/services/report-whatsapp-service.ts:45-141`, `src/services/thank-you-whatsapp.ts:28-49` | Medio | F |
| H8 | `pdfkit` ya instalado → sin dependencia nueva. | `src/services/contract-service.ts:48-82` | Reutilización | E |
| H9 | `numberToSpanishWords` sirve para `spokenTotal` e "importe con letra"; hoy vive dentro de un servicio de prompts. | `src/services/plans-prompt-formatter.ts:72` | Reutilización | C |
| H10 | Provisión de tools por features con lista estática; agregar las de cotización. | `src/services/agent-provisioning.ts:17-53` | Obligatorio | D |
| H11 | El factory reset borra tablas una por una; las nuevas deben agregarse. | `db/migrations/74_factory_reset_extended.sql:54` | Obligatorio | A |
| H12 | **No existe ningún campo de tipo de partida.** `products` no distingue producto/servicio/plan; `product_variants.stock_status` (`disponible`, `bajo`, `agotado`, `bajo_pedido`, `sin_dato`) se aplica igual a un gel que a una consultoría — un servicio hoy se verbaliza como "no tengo el dato de existencias". Tampoco hay modalidad de cobro. **Sí existe el dominio** `billing_period in ('mensual','anual','unico')` en `deployments` (`55_control_plane_datagol.sql:92-93`), con espejo en el frontend (`src/types/constraints/billing-period.ts`) — se reutiliza en vez de inventar uno nuevo. | `db/migrations/56_catalogo_productos.sql:240-316` | Bloqueante para planes | B2 |
| H13 | **Falta la clave de unidad SAT** (`c_ClaveUnidad`), obligatoria en CFDI 4.0. `sat_product_key` sí existe en `products`. | `db/schema.md` | Preparación factura | B2 |
| H14 | Permisos `view_catalog`/`manage_catalog`/`export_data` existen; faltan `view_quotations`/`manage_quotations`. | `db/migrations/45_rbac_permisos.sql:60-76` | Obligatorio | A |
| H15 | La idempotencia de tools ya establecida es por clave natural con índice único (`ux_appointments_org_conversation_id`); la resolución de contacto es `resolveContactBestEffort` → RPC `resolve_contact` (teléfono → correo → nuevo). | `src/routes/tools/booking.ts:27,77-83,97,214-240` | Diseño | D |
| H16 | **`plans` no es solo una lista de precios**: es la fuente de entitlements (`plan_features`), `max_concurrent_calls` (sincronizado a `organizations`), `max_users`, `max_mailboxes`, copy de marketing y el bloque fonético del prompt. Lo consumen `src/routes/plans.ts` (público, landing en tiempo real, sin caché), `src/routes/admin/plans.ts:90-190` (CRUD), `plans-agent-sync.ts:44-45` y `deployment-service.ts:30`. **Por eso no se puede invertir la fuente de verdad hacia el catálogo**: el catálogo es una proyección. | ver columna | Diseño | B2 |
| H17 | **Descuento anual como literal en el frontend**: `Pricing.tsx` calcula `Math.round(rawRetainer * 0.8)`. Si el agente cotiza una iguala anual, el precio debe coincidir con la landing — el 20 % debe vivir en `plans`. | `mi-new-app/src/components/landing/Pricing.tsx` (cálculo de `retainerPrice`) | Medio | B2 |
| H18 | `publicPlanSchema` en el frontend es **`.strict()`**: agregar cualquier campo a la respuesta de `GET /api/plans/public` **rompe la validación de la landing** hasta que el frontend acepte el campo. Obliga a un orden de despliegue frontend → backend. | `mi-new-app/src/types/api-schemas.ts:615-630` | Alto (riesgo de landing caída) | B2 |
| H19 | **Las políticas RLS de escritura del catálogo no verifican feature** (`products_write`, `product_variants_write` solo exigen `catalog_access.can_edit` + `manage_catalog`), y el frontend escribe directo con Supabase (`AddProductDialog.tsx:141,160`, `PriceEditTable.tsx:125`). La verificación de feature del catálogo hoy no es autoritativa en servidor. | `db/schema.md` (RLS `products`, `product_variants`) | Medio (preexistente) | B |
| H20 | Los add-ons de la landing (`ADDONS_DATA`) son **precios literales MXN y USD** en `mi-new-app/src/config/landing-data.ts:123-170`, contra la regla de fuente única que ya se aplicó a `plans`. Son servicios cotizables. | ver columna | Bajo (opcional) | B2 |
| H21 | La landing ya renderiza un **catálogo público** de la organización por defecto (`mi-new-app/src/components/landing/Catalog.tsx` → `getPublicCatalogProducts`, condicionado en `src/app/page.tsx:160`). Al proyectar los planes a un catálogo de esa misma organización, aparecerían duplicados en la landing junto a la sección de Pricing. El catálogo administrado debe excluirse del catálogo público. | ver columna | Medio | B2 / frontend F3 |

---

## FASE A — Feature, permisos y constraints

1. Feature (en `77_quotations.sql`):
   ```sql
   insert into public.features (key, name, description, category, requires_provider, has_cost_impact, globally_disabled, sort_order)
   values ('quotations', 'Cotizaciones', 'Carrito conversacional por contacto y cotizaciones en PDF con folio enviadas por correo o WhatsApp.', 'operacion', null, false, false, 70)
   on conflict (key) do update set name = excluded.name, description = excluded.description, category = excluded.category;

   insert into public.plan_features (plan_key, feature_key, enabled) values
     ('starter', 'quotations', false), ('pro', 'quotations', true),
     ('elite', 'quotations', true),    ('enterprise', 'quotations', true)
   on conflict (plan_key, feature_key) do update set enabled = excluded.enabled;
   ```
   `requires_provider = null` (WhatsApp lo gobierna la feature `whatsapp`, verificada al enviar, criterio de `waitlist`). `has_cost_impact = false`.
2. Permisos `view_quotations` (`datos`) y `manage_quotations` (`operacion`) + `role_permissions` (`owner`/`admin`/`member`: ambos; `viewer`: solo `view_quotations`). Exportación con `export_data`.
3. Agregar las tablas nuevas a `factory_reset_transactional_data()` con `create or replace` en migración nueva (H11); el reset reinicia folios.
4. Módulos de constraint en `src/types/` con prueba de inserción contra la base real (patrón `__tests__/feature-taxonomy.test.ts`):
   - `catalog-item-type.ts` (`producto`, `servicio`, `plan`) y `billing-period.ts` (`unico`, `mensual`, `anual`) — este último no existe aún en el backend (solo en el frontend) y lo comparten `deployments.billing_period` y `product_variants.billing_period`; su prueba de inserción cubre ambas columnas.
   - `stock-status.ts`: agregar `no_aplica` y su verbalización (cadena vacía: no se menciona existencia).
   - `quotation-status.ts`, `quotation-origin.ts`, `quotation-delivery.ts`, `quotation-event-type.ts`.
   - `FEATURE_KEYS.QUOTATIONS`.
5. Actualizar `db/schema.md`. **Recordatorio:** las migraciones se aplican manualmente; preguntar antes de ejecutar DDL contra Supabase.

---

## FASE B — Abrir el catálogo a `pro` sin abrir la KB

1. `src/services/entitlements.ts`: `hasCatalogAccess(features)` → `PRODUCT_RAG || QUOTATIONS`, con **una** llamada a `getOrganizationFeatures` (§16).
2. `catalogs.ts:87` y `tools/products.ts:66`: usar `hasCatalogAccess`.
3. **H2:** `syncCatalogKbHandler` verifica `product_rag` de `ownerOrganizationId` antes de leer `product_kb_sync`; sin ella, log con `tenant_id` y salida sin efecto.
4. **H3:** `create or replace function resolve_variant_for_org` con `ORDER BY (c.owner_organization_id = p_org_id) DESC, v.catalog_id` y devolviendo además `variant_id`, `product_id`, `catalog_id`, `item_type`, `is_inventoriable`, `billing_period` (cambiar la firma exige `DROP FUNCTION` + recrear; `tools/products.ts` ignora columnas extra).
5. **H19:** función `organization_has_catalog_feature(p_org_id uuid) returns boolean` (`stable`, `security definer`, basada en `organization_enabled_features`) y agregarla a `products_write`, `product_variants_write`, `catalog_custom_fields` y `catalog_imports` en una migración nueva. Así la feature es autoritativa también para las escrituras directas del frontend. Probar que `starter` con `manage_catalog` no puede insertar y `pro` sí.
6. Pruebas: `pro` crea catálogo, importa y consulta precios; `starter` recibe 403 `FEATURE_DISABLED`; `pro` sin `product_rag` no sincroniza KB, con `product_rag` sí.

> Mergeable de forma independiente: desbloquea la carga de catálogos `pro`.

---

## FASE B2 — Tipos de partida y puente de planes (`76_catalog_item_types_and_plans_bridge.sql`)

### B2.1 Tipo de partida y modalidad de cobro

| Tabla | Columna | Definición | Motivo |
|---|---|---|---|
| `products` | `item_type` | `text not null default 'producto' check (item_type in ('producto','servicio','plan'))` | H12. Backfill: todo lo existente queda `producto` (comportamiento actual intacto). |
| `products` | `is_inventoriable` | `boolean generated always as (item_type = 'producto') stored` | Derivado, nunca capturado: no puede contradecir al tipo. |
| `products` | `bundle_parent_id` | `uuid null`, FK compuesta `(bundle_parent_id, catalog_id) → products(id, catalog_id) on delete set null` | Servicio complementario de un plan (la iguala de mantenimiento de un plan). Mismo catálogo obligatorio. |
| `product_variants` | `billing_period` | `text not null default 'unico' check (billing_period in ('unico','mensual','anual'))` | Mismo dominio que `deployments.billing_period`: una columna, sin combinaciones incoherentes posibles. `mensual`/`anual` = recurrente. |
| `product_variants` | `sat_unit_key` | `text null` | H13 (`H87` pieza, `E48` unidad de servicio, etc. — la captura el cliente; sin literales de código SAT en el código). |
| `product_variants` | `stock_status` | ampliar el `CHECK` con `'no_aplica'` | Ver trigger. |

Trigger `enforce_variant_item_type` (`BEFORE INSERT OR UPDATE` en `product_variants`, y `AFTER UPDATE OF item_type` en `products` que reajusta sus variantes):
- Producto **no inventariable** (`servicio`, `plan`) → `stock_status` se fuerza a `'no_aplica'` y `stock_note` a `null`.
- Producto **inventariable** → `stock_status = 'no_aplica'` se rechaza (si se cambia un servicio a producto, sus variantes pasan a `sin_dato`).

Efectos en código:
- `stockStatusToSpeech('no_aplica')` → `''`; el tool de productos y el de búsqueda omiten `availabilityText` para no inventariables (el agente no dice "creo que hay disponible" de una consultoría).
- `organization_variant_overrides.stock_status` se ignora para no inventariables (en `resolve_variant_for_org`).
- `catalog-import-service.ts`: columnas mapeables `item_type`, `billing_period`, `sat_unit_key`, con validación contra los módulos de constraint; default `producto` / `unico`. El preview reporta filas con combinación inválida.
- `catalog-kb-document.ts`: el documento de KB indica el tipo ("servicio, pago mensual") — sin precio, como hoy.

### B2.2 Catálogos administrados

`catalogs.managed_source text null check (managed_source in ('datagol_plans'))` + índice único parcial `where managed_source is not null` → **a lo más un catálogo proyectado de planes por instalación**.

Trigger `guard_managed_catalog_rows` en `products` y `product_variants`: si el catálogo tiene `managed_source` y `current_setting('datagol.managed_sync', true)` no es `'on'`, rechaza `INSERT`/`DELETE` y el `UPDATE` de los campos administrados (`name`, `item_type`, `bundle_parent_id`, `external_id`, `is_active`, `sku`, `price`, `currency`, `price_includes_tax`, `tax_rate`, `billing_period`). Quedan editables a mano: imagen, `description` adicional, `keywords`, `sat_product_key`, `sat_unit_key`, `custom_fields`. Mensaje del error: "Este campo se administra desde Planes (/admin/plans)". Es un trigger y no lógica del backend porque el frontend escribe el catálogo directo (H19).

### B2.3 Proyección `plans` → catálogo

`plans` sigue siendo la fuente de verdad (H16). Cambios en `plans`:
- `annual_retainer_discount_pct numeric(5,4) not null default 0.2000 check (between 0 and 0.9)` — saca el 20 % del literal de `Pricing.tsx` (H17).

Función `sync_plan_to_catalog(p_plan_key text)` (`security definer`; hace `set_config('datagol.managed_sync','on', true)`, local a la transacción) y trigger `AFTER INSERT OR UPDATE OR DELETE ON plans FOR EACH ROW` que la invoca **en la misma transacción**. Proyección por plan (solo si existe el catálogo con `managed_source = 'datagol_plans'`; si no, no hace nada):

| Partida | `products` | Variante(s) | Precio |
|---|---|---|---|
| Plan (setup) | `item_type = 'plan'`, `name = plans.name`, `description` = `target_audience` + `setup_includes`, `external_id = 'plan:{key}'` | `PLAN-{KEY}`: `billing_period = 'unico'` | `setup_fee_mxn` |
| Mantenimiento (iguala) | `item_type = 'servicio'`, `name = 'Mantenimiento ' || plans.name`, `description` = `retainer_includes`, `bundle_parent_id` = producto del plan, `external_id = 'plan-retainer:{key}'` | `MANT-{KEY}-MENSUAL`: `billing_period = 'mensual'` · `MANT-{KEY}-ANUAL`: `billing_period = 'anual'` | mensual = `monthly_fee_mxn`; anual = `round(monthly_fee_mxn × (1 − annual_retainer_discount_pct)) × 12` |

Reglas de la proyección:
- Todas las variantes: `currency = 'MXN'`, `price_includes_tax = false`, `tax_rate = 0.16` (la landing declara "precios más IVA"; si eso cambia, se vuelve columna de `plans`, no literal).
- **Redondeo idéntico a la landing**: el precio anual redondea el mensual con descuento **antes** de multiplicar por 12, exactamente como `Pricing.tsx` muestra la cifra por mes. Prueba de paridad obligatoria.
- `monthly_fee_mxn is null` ("Iguala a medida") → variantes de mantenimiento con `price = null`: el agente responde "la iguala se cotiza a medida con un asesor" y la partida no se puede agregar al carrito.
- `show_retainer = false` → producto de mantenimiento `is_active = false`. `plans.is_active = false` o `DELETE` → ambos productos `is_active = false` (nunca se borran: cotizaciones emitidas los referencian por ID).
- Idempotente: upsert por `external_id` dentro del catálogo; ejecutarla N veces deja el mismo estado. El historial `variant_price_history` se llena solo por el trigger existente `record_price_change` (fuente = `UPDATE`); agregar a la función que el `source` registre `'plans_sync'` (cambio a `record_price_change` para leer `current_setting('datagol.price_source', true)`).
- `max_concurrent_calls`, `max_users`, `max_mailboxes` y `plan_features` **no** se proyectan: no son datos cotizables.
- **H21:** el catálogo administrado nunca aparece en el catálogo público de la landing (los planes ya tienen su sección de Pricing). El filtro `managed_source is null` se aplica en la consulta pública del frontend y, como defensa, en cualquier endpoint público de catálogo del backend.

Vinculación (una vez, por superadmin): `POST /api/admin/plans/catalog-binding { organizationId }` crea el catálogo `"Planes Datagol"` con `managed_source = 'datagol_plans'` en esa organización (la organización por defecto de la landing, la que el frontend conoce como `NEXT_PUBLIC_DEFAULT_ORG_ID`) y ejecuta `sync_plan_to_catalog` para todos los planes. `GET` del mismo endpoint devuelve el estado (`catalogId`, productos proyectados, último sync). Sin variable de entorno nueva: el vínculo vive en datos.

### B2.4 Contrato público de planes (H18 — orden de despliegue)

`GET /api/plans/public` agrega `annualDiscountPct` y `catalogRefs: { setupSku, monthlySku, annualSku } | null`. Como `publicPlanSchema` es `.strict()`:

1. **Primero** se despliega el frontend aceptando ambos campos como opcionales (tarea hermana, Fase F1).
2. **Después** el backend los envía.
3. **Después** el frontend deja de usar el literal `0.8`.

`PATCH /api/admin/plans/:key` acepta `annualRetainerDiscountPct` (Zod con el mismo rango del CHECK). La landing sigue leyendo `plans` en tiempo real: **no cambia su fuente ni su latencia**.

### B2.5 Add-ons como servicios (opcional, recomendado)

H20: los add-ons pasan a ser productos `item_type = 'servicio'` en el catálogo de la organización por defecto (no administrados por `plans`: se editan en el catálogo) con `category = 'addon'` y variantes `billing_period = 'unico'` (setup) / `'mensual'` (opcional). Endpoint público `GET /api/plans/public/addons?organizationId=` con whitelist de columnas (mismo criterio que `public-profile`), incluyendo `tipoCambioUsd` para el cálculo USD del frontend. Elimina el último precio literal de la landing y hace cotizables los add-ons.

### B2.6 Pruebas de la fase
- Backfill: catálogo existente intacto (`producto`, `unico`, mismas existencias).
- Servicio no puede tener `stock_status` distinto de `no_aplica`; producto no puede tener `no_aplica` (rechazo + éxito).
- `billing_period` fuera del dominio rechazado; `unico`/`mensual`/`anual` aceptados.
- Cambiar `setup_fee_mxn` en `plans` actualiza `PLAN-{KEY}` en la misma transacción; con el `PATCH` real de `/api/admin/plans`.
- **Paridad con la landing**: para todos los planes semilla, el precio anual proyectado / 12 = `Math.round(monthly × 0.8)` de `Pricing.tsx`.
- Edición directa (rol `authenticated`, como el frontend) del precio de una variante administrada → rechazada; de su imagen o `sat_unit_key` → aceptada.
- Sin catálogo vinculado, actualizar `plans` no falla ni crea nada.
- `GET /api/plans/public` mantiene todos los campos previos (prueba de contrato).

---

## Modelo de datos de cotizaciones (`77_quotations.sql`)

Todas las tablas llevan `organization_id` y RLS habilitada. **Política solo de lectura** para `authenticated` con `has_permission(organization_id, 'view_quotations')` (patrón de `contacts_read`). **No hay políticas de escritura**: toda mutación pasa por el backend (`supabaseAdmin`), porque la máquina de estados, los folios y el cálculo no deben poder saltarse escribiendo directo desde el navegador.

### `quotation_settings` (1 fila por organización)

| Columna | Tipo | Notas |
|---|---|---|
| `organization_id` | `uuid` PK | |
| `folio_prefix` | `text` | Default `'COT'`. `CHECK (folio_prefix ~ '^[A-Z0-9]{1,8}$')` |
| `validity_days` | `int4` | Default 15, `1..365` |
| `cart_ttl_hours` | `int4` | Default **168** (7 días; el carrito por contacto sobrevive entre conversaciones). `24..2160` |
| `max_items` | `int4` | Default 30 |
| `terms_text` / `notes_default` | `text` | |
| `email_sender` | `text` | `'auto' \| 'resend' \| 'mailbox'` |
| `email_account_id` | `uuid` | Nullable, FK `email_accounts` |
| `whatsapp_template_name` | `text` | Nullable; plantilla con encabezado de documento para fuera de ventana de 24 h |
| `updated_at` / `updated_by` | | |

Son valores de configuración, no banderas de habilitación (§16).

### `quotation_folio_counters`

`(organization_id, year)` PK, `last_value int8`. Se incrementa con `UPDATE ... RETURNING` en la misma transacción que emite → sin huecos.

### `quotations`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `organization_id` | `uuid` | |
| `status` | `text` | `borrador`, `abandonada`, `emitida`, `enviada`, `aceptada`, `rechazada`, `vencida`, `cancelada`, `convertida` |
| `origin` | `text` | `agente`, `dashboard`, `revision` |
| `contact_id` | `uuid` | **`NOT NULL` mientras `status = 'borrador'`** (CHECK); FK `contacts` `ON DELETE SET NULL` |
| `first_conversation_id` / `last_conversation_id` | `text` | Trazabilidad entre conversaciones; no son llave |
| `last_channel` | `text` | `voz`, `whatsapp`, `web`, `dashboard` |
| `customer_name` / `customer_email` / `customer_phone_e164` / `customer_business_name` | `text` | Snapshot al emitir |
| `folio` / `folio_year` / `folio_number` | `text` / `int4` / `int8` | `UNIQUE (organization_id, folio)` |
| `revision_of_id` / `revision_number` | `uuid` / `int4` | |
| `currency` | `text` | Una moneda por cotización |
| `subtotal` / `tax_total` / `discount_total` / `total` | `numeric(14,2)` | `total` = **total inicial** (pagos únicos + primer periodo de recurrentes) |
| `totals_by_billing` | `jsonb` | `[{ billingPeriod: 'unico', subtotal, tax, total }, { billingPeriod: 'mensual', subtotal, tax, total }, …]` |
| `tax_breakdown` | `jsonb` | Por tasa |
| `notes` / `terms_text` | `text` | Snapshot de settings |
| `issued_at` / `valid_until` | `timestamptz` / `date` | `valid_until` en `organizations.timezone` |
| `pdf_storage_path` / `pdf_sha256` / `pdf_generated_at` | | |
| `last_activity_at` | `timestamptz` | |
| `accepted_at` / `rejected_at` / `cancelled_at` / `status_reason` | | |
| `created_at` / `updated_at` / `created_by` | | `created_by` null = agente |

Índices:
- **`UNIQUE (organization_id, contact_id) WHERE status = 'borrador'`** — un solo carrito abierto por contacto (D2). Es la llave de idempotencia de las tools de carrito.
- `(organization_id, status, issued_at DESC)`, `(organization_id, contact_id, created_at DESC)`, `(status, last_activity_at) WHERE status in ('borrador','abandonada')`.

### `quotation_items`

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | Futuro `source_quotation_item_id` |
| `quotation_id` / `organization_id` | `uuid` | `organization_id` redundante a propósito |
| `line_number` | `int4` | `UNIQUE (quotation_id, line_number)` |
| `variant_id` / `product_id` / `catalog_id` | `uuid` | **Sin FK, deliberadamente** (ver nota) |
| `sku` / `external_id` / `sat_product_key` / `sat_unit_key` | `text` | Snapshot |
| `item_type` / `billing_period` | `text` | Snapshot (B2) |
| `product_name` / `presentation` / `description` | `text` | Snapshot |
| `quantity` | `numeric(12,3)` | `> 0` |
| `unit_price` | `numeric(14,4)` | Resuelto por `resolve_variant_for_org` |
| `price_includes_tax` / `tax_rate` | `bool` / `numeric(5,4)` | |
| `discount_amount` | `numeric(14,2)` | Default 0; solo dashboard |
| `line_subtotal` / `line_tax` / `line_total` | `numeric(14,2)` | |
| `created_at` / `updated_at` | | |

`UNIQUE (quotation_id, variant_id)`.

> **Sin FK a `product_variants`:** `CASCADE` destruiría cotizaciones emitidas, `SET NULL` perdería el ID que se debe conservar y `RESTRICT` bloquearía el borrado de catálogos. La integridad se verifica al insertar (solo variantes resueltas para la organización) y el snapshot hace a la partida autosuficiente.

### `quotation_deliveries`

`id, organization_id, quotation_id, channel ('email'|'whatsapp'), recipient, status ('pendiente'|'enviado'|'error'|'omitido'), skip_reason, error, provider_message_id, idempotency_key UNIQUE (organization_id, idempotency_key), attempts, sent_at, created_at`.

### `quotation_events` (append-only)

`id, organization_id, quotation_id, event_type, actor_user_id, conversation_id, payload jsonb, created_at`. Eventos: `carrito_creado`, `carrito_retomado`, `partida_agregada`, `cantidad_cambiada`, `partida_eliminada`, `emitida`, `precio_cambiado_al_emitir`, `pdf_generado`, `enviada`, `envio_fallido`, `aceptada`, `rechazada`, `vencida`, `cancelada`, `revisada`, `exportada`, `abandonada`. Sin `UPDATE`/`DELETE` (patrón `feature_audit_log`), **salvo** el borrado en cascada de una cotización `abandonada` purgada por retención.

### Triggers e invariantes

1. **Inmutabilidad:** partidas solo modificables en `borrador`; cabecera emitida solo cambia `status`, `status_reason`, `*_at` de transición y campos de PDF nulos.
2. **Máquina de estados** (`quotation_transition_allowed`):
   - `borrador → emitida | abandonada | cancelada`
   - `abandonada → borrador` (el contacto vuelve antes de la purga)
   - `emitida → enviada | cancelada | vencida | aceptada | rechazada`
   - `enviada → aceptada | rechazada | vencida | cancelada`
   - `aceptada → convertida` (reservado)
3. **Tope de partidas** dentro de la RPC.
4. **Un borrador por contacto**: además del índice, al reabrir una `abandonada` se verifica que no exista otro `borrador` del contacto (si existe, se conserva el más reciente y el otro queda `abandonada`).

### RPCs (`security definer`, `search_path = public, pg_temp`)

- **`quotation_cart_apply(p_org_id, p_contact_id, p_conversation_id, p_channel, p_op, p_sku, p_quantity) → jsonb`** — `p_op in ('set','remove','view')`. Busca el borrador del contacto (o reabre su `abandonada` más reciente, o crea uno con `ON CONFLICT` sobre el índice parcial); resuelve la variante; rechaza precio `null` ("a medida") y variantes no disponibles; upsert con **cantidad absoluta** (`set` 0 = eliminar); actualiza `last_conversation_id`, `last_channel`, `last_activity_at`; evento (`carrito_retomado` si la conversación cambió); devuelve partidas y bandera `resumed`.
- **`quotation_emit(p_org_id, p_quotation_id, p_customer jsonb, p_totals jsonb) → jsonb`** — `FOR UPDATE`; si ya está emitida devuelve el folio existente; re-resuelve precio/disponibilidad (reporta `priceChanges`); incrementa contador; asigna folio y totales (calculados por el servicio puro, validando invariantes en SQL); snapshots; evento.
- **`quotation_search_products(p_org_id, p_query, p_limit) → table`** — `pg_trgm` sobre `products.name/keywords/brand` y `product_variants.sku/presentation`, restringida a `catalog_access`, variantes activas; devuelve `item_type`, `billing_period` y, para planes, el SKU de su mantenimiento (`bundle_parent_id`). Índices GIN `gin_trgm_ops` (verificar si la extensión ya está habilitada).
- **`purge_abandoned_quotations() → jsonb`** — D3: `DELETE FROM quotations WHERE status = 'abandonada' AND last_activity_at < now() - (o.retention_days || ' days')::interval` (join con `organizations`), cascada a partidas y eventos. **Ningún otro estado se toca.** Programada diariamente con `pg_cron`, mismo patrón que `purge_expired_call_content()` (`18_call_content_retention_purge.sql:42`). Devuelve conteo por ejecución.

> **Aritmética:** fuente de verdad en el servicio puro de la Fase C (mutación ≥ 90 %); la RPC de emisión recibe los totales y valida invariantes baratos (`total = Σ partidas`, coherencia por modalidad).

---

## FASE C — Servicios puros (`src/services/quotations/`)

Sin imports de Fastify. Categoría cálculo de costos → mutación ≥ 90 %.

1. **`quotation-math.ts`**
   - Centavos enteros; nunca flotantes sobre importes.
   - Por partida: con IVA incluido `base = round(precio × cant / (1 + tasa))`, `iva = total − base`; sin IVA `base = round(precio × cant)`, `iva = round(base × tasa)`. Descuento sobre la base antes de impuestos.
   - Redondeo por partida a 2 decimales, half-up; totales = suma de partidas (compatible con CFDI 4.0).
   - **Agrupación por modalidad**: `totals_by_billing` separa pago único de cada periodo recurrente (`mensual`, `anual`); `total` = únicos + primer periodo de recurrentes. Un plan cotizado con su mantenimiento mensual produce: "Pago único $X + IVA; mantenimiento $Y + IVA mensuales".
   - `tax_breakdown` por tasa. Monedas mezcladas → error tipado verbalizable.
2. **`src/lib/number-to-spanish-words.ts`** — extraer `numberToSpanishWords` de `plans-prompt-formatter.ts:36-124` (sus pruebas siguen verdes). Agregar `amountToSpokenSpanish(cents, currency)` y `amountToLegalSpanish(cents, currency)` ("(MIL OCHOCIENTOS CINCUENTA PESOS 50/100 M.N.)").
3. **`quotation-folio.ts`** — `formatFolio(prefix, year, number, revision)`.
4. **`quotation-cart-summary.ts`** — respuesta verbalizable: máximo 5 partidas enumeradas, "y N más"; frase por modalidad ("cuarenta y nueve mil pesos de pago único más tres mil novecientos noventa y nueve mensuales, más IVA"); si `resumed`, frase de retoma ("Tenía guardada una cotización con 2 productos, ¿la continuamos?").
5. **`quotation-validity.ts`** — `valid_until` en `organizations.timezone`.

---

## FASE D — Tools en vivo (`src/routes/tools/quotation.ts`)

Patrón de `products.ts`/`booking.ts`: tenant por `webhookToken` + `x-tool-secret`, Zod de body y respuesta (`src/schemas/quotation-tool.ts`), `withToolTimeout`, siempre HTTP 200 con mensaje verbalizable en degradado, feature verificada tras autenticar. Registrar en `src/routes/tools/index.ts`.

| Ruta | Body | Efecto |
|---|---|---|
| `POST /tools/:webhookToken/quotation/search` | `{ query, limit? ≤ 3 }` | Lectura |
| `POST /tools/:webhookToken/quotation/cart/set-item` | `{ conversationId, customerPhone?, customerEmail?, customerName?, sku, quantity }` | `set`; `quantity: 0` elimina |
| `POST /tools/:webhookToken/quotation/cart/remove-item` | `{ conversationId, customerPhone?, customerEmail?, sku }` | `remove` |
| `POST /tools/:webhookToken/quotation/cart/view` | `{ conversationId, customerPhone?, customerEmail? }` | `view` (también detecta carrito previo del contacto) |
| `POST /tools/:webhookToken/quotation/finalize` | `{ conversationId, customerPhone?, customerEmail?, customerName, channels: ('email'\|'whatsapp')[] }` | `quotation_emit` + encolar PDF |

### Identidad del contacto (D2)

- Cada llamada resuelve el contacto con `resolveContactBestEffort` (`booking.ts:220`, RPC `resolve_contact`: teléfono E.164 → correo → nuevo). Sin teléfono ni correo → mensaje para pedir uno; no se crea carrito anónimo.
- **El teléfono no lo debe inventar el LLM.** En la configuración de las tools de ElevenLabs, `customerPhone` se llena con la variable dinámica del sistema `system__caller_id` como valor constante del parámetro (no como parámetro que el LLM rellena). En WhatsApp es el número del remitente; en web chat no existe y se usa el correo dictado. Verificar en la documentación vigente de ElevenLabs que el tipo de parámetro "dynamic variable" sigue disponible para webhook tools, y documentarlo en `docs/elevenlabs-endpoints-manual.md`.
- Riesgo residual documentado: en web chat el correo lo dicta el usuario; un tercero que dicte el correo de otro contacto podría ver el contenido de su carrito (solo SKU, cantidades y total — sin datos personales). Mitigación v1: `view` en canal `web` solo retoma carritos cuyo `last_channel` sea `web` y cuya última actividad sea < 24 h; para retomar entre canales se requiere teléfono.
- `organization_id` nunca sale del body (§5); `contact_id` se resuelve siempre dentro de la organización del token.

### Reglas

- **Cantidad absoluta** → reintentos idempotentes; "agrega dos más" lo resuelve el LLM con la cantidad del `cart` previo.
- **`finalize` idempotente:** si el contacto no tiene borrador pero tiene una cotización emitida con `last_conversation_id = conversationId` en los últimos 30 min, devuelve ese folio (reintento del agente) en vez de "carrito vacío".
- Canal sin dato (WhatsApp sin teléfono, correo sin email) → pedir el dato antes de emitir.
- Producto no encontrado/inactivo/agotado o con precio "a medida" → mensaje verbalizable, nunca 4xx.
- **Planes:** al agregar un `plan`, la respuesta incluye `suggestedComplement` (SKU del mantenimiento mensual) para que el agente lo ofrezca como opcional; nunca se agrega solo.
- Feature deshabilitada → "No puedo armar cotizaciones en este momento; ¿le tomo sus datos y le enviamos la información?".
- Una RPC por tool; objetivo p95 < 300 ms (los timeouts de `tool-timeout.ts:7-9` son límites duros, no objetivo).

### Provisión y prompt

1. `agent-provisioning.ts`: las cinco tools con `requiredFeature: 'quotations'`.
2. Bloque de instrucciones (`src/lib/agent-prompts.ts`, inyección por sección como `injectPlansSectionIntoPrompt`): confirmar producto/cantidad; `view` al inicio si el contacto es recurrente (retomar carrito); repasar antes de `finalize` con confirmación explícita; leer siempre `spokenTotal`; nunca descuentos; avisar `priceChanges`; no mencionar existencias de servicios/planes; ofrecer el mantenimiento de un plan como opcional.

---

## FASE E — PDF (`src/services/quotations/quotation-pdf.ts`)

1. `pdfkit`; `renderQuotationPdf(data): Promise<Buffer>` pura, sin red ni BD.
2. Contenido: datos y tema de la organización (`resolveOrganizationEmailOptions`, `email.ts:51`); folio/revisión; emisión y vigencia en zona de la organización; cliente; tabla (#, SKU, descripción, cantidad, precio unitario, importe, **modalidad**: "Único", "Mensual", "Anual"); **bloques de totales por modalidad** (pago único / mensual / anual), desglose de IVA, total inicial; importe con letra del total inicial; notas y condiciones; leyenda "Cotización — no es comprobante fiscal".
3. Paginación con encabezado repetido. Sin imágenes en v1 (tope de 7 MB en `email.ts:522`).
4. Bucket privado `quotations`, ruta `{organization_id}/{folio_year}/{folio}.pdf`, `pdf_sha256`; URL firmada solo bajo demanda. Si excede tamaño, enlace firmado en vez de adjunto.

---

## FASE F — Jobs y entrega (`src/jobs/`)

1. **`generate-quotation-pdf`** `{ organizationId, quotationId }` — verifica `quotations` al ejecutar (§16); no regenera si ya hay PDF; crea `quotation_deliveries` con `ON CONFLICT DO NOTHING` y encola `deliver-quotation`.
2. **`deliver-quotation`** `{ organizationId, deliveryId }` — sale si ya `enviado`.
   - **Email** según `email_sender`: `mailbox` → `dispatchOrSaveDraft` extendido con `attachments` (H5); `resend` → patrón `sendThankYouEmail` con `replyTo` de la organización; `auto` → `mailbox` si hay buzón activo y `email_integration`, si no `resend`.
   - **WhatsApp** — feature `whatsapp`, credenciales, contacto no `opted_out`, E.164 válido. Dentro de ventana de 24 h → `type: 'document'` (enlace firmado ≥ 24 h, `filename = {folio}.pdf`, `caption` con folio y total); fuera → plantilla configurada o `omitido` (`fuera_de_ventana_sin_plantilla`). Nuevo `src/services/quotations/quotation-whatsapp.ts` (H7); registrar en `whatsapp_messages`.
   - Primer envío exitoso: `emitida → enviada`.
3. **Metering (§6):** WhatsApp → `usage_events` con `getRate(fastify, 'meta', <unit_type>, now)` e `idempotency_key = 'wa-quotation:{waMessageId}'`; tarifa desde `provider_rates`, nunca literal (agregar fila si el `unit_type` es nuevo). Resend no se mide hoy (consistente con el sistema); anotado.
4. **`sweep-quotations`** (scheduler pg-boss, cada hora): `borrador` sin actividad > `cart_ttl_hours` → `abandonada`; `emitida`/`enviada` con `valid_until` vencido → `vencida`. Evento y log por tenant. (La **purga** de abandonadas es `purge_abandoned_quotations()` vía `pg_cron`, separada a propósito: el sweep cambia estado, la purga borra.)
5. Reintentos con backoff; al agotar → `error` + log con `tenant_id`, `quotation_id`, `conversation_id`.

---

## FASE G — API del dashboard (`src/routes/organization-quotations.ts`)

Sesión Supabase, `organizationId` de la ruta verificado contra membresía, permiso + feature `quotations` en servidor, Zod en `params`/`querystring`/`body`/`response`.

| Método y ruta | Permiso | Descripción |
|---|---|---|
| `GET /api/organizations/:id/quotations` | `view_quotations` | Lista paginada; filtros `status`, `from`, `to`, `contactId`, `q` |
| `GET /api/organizations/:id/quotations/:quotationId` | `view_quotations` | Detalle + partidas + entregas + eventos |
| `GET /api/organizations/:id/quotations/:quotationId/pdf` | `view_quotations` | URL firmada corta |
| `GET /api/organizations/:id/contacts/:contactId/quotations` | `view_quotations` | Historial y carrito abierto del contacto (vista CRM) |
| `POST /api/organizations/:id/quotations` | `manage_quotations` | Crear borrador para un `contactId` (si ya tiene uno, 409 con su id) |
| `PUT /api/organizations/:id/quotations/:quotationId/items` | `manage_quotations` | Reemplazar partidas de un borrador (incluye descuentos) |
| `POST /api/organizations/:id/quotations/:quotationId/emit` | `manage_quotations` | Emitir |
| `POST /api/organizations/:id/quotations/:quotationId/send` | `manage_quotations` | Reenviar por canal(es) |
| `POST /api/organizations/:id/quotations/:quotationId/status` | `manage_quotations` | `aceptada`/`rechazada`/`cancelada` con `reason` |
| `POST /api/organizations/:id/quotations/:quotationId/revise` | `manage_quotations` | Revisión `-R{n}` |
| `GET /api/organizations/:id/quotations/export` | `export_data` | Fase H |
| `GET` / `PUT /api/organizations/:id/quotation-settings` | `view_quotations` / `manage_quotations` | Configuración |
| `GET /api/organizations/:id/catalog/search?q=` | `view_quotations` | Mismo `quotation_search_products`, para el editor de borradores |

Notas:
- **Aceptada → valor de cierre:** la respuesta sugiere `suggestedDealValue` (total inicial) pero no escribe `contacts.deal_value`; eso sigue en `PATCH .../contacts/:contactId/pipeline` con `close_deals` (AGENTS §6).
- **ARCO:** `erase_contact_pii` (`11_contact_erasure.sql`) debe anonimizar `customer_*` de las cotizaciones del contacto y `recipient` de sus entregas, conservando folio e importes; su borrador abierto se elimina. Migración nueva con `create or replace`.
- **Retención (D3):** solo `purge_abandoned_quotations()`; ninguna otra purga toca cotizaciones.

---

## FASE H — Exportación y preparación para remisión/factura

1. **`GET .../quotations/export?format=json|csv|xlsx&from&to&status`** — `json` versionado `{ schema: 'datagol.quotation.v1', quotations: [...] }` con todos los IDs y `item_type`/`billing_period`/`sat_unit_key`; `csv`/`xlsx` (`exceljs`) una fila por partida. Límites de rango/filas, stream, evento `exportada`.
2. **Contrato futuro** (no se construye): `sales_documents.source_quotation_id` / `source_quotation_item_id`; conversión exige `aceptada` → `convertida`; CFDI necesitará datos fiscales del receptor (no se piden en la cotización). Las partidas recurrentes generarán un documento por periodo — por eso se conserva `billing_period`.
3. **Webhook saliente** al sistema del cliente (`quotation.emitted`/`quotation.accepted`, HMAC con secreto en `organization_secrets`, pg-boss). Fuera de v1.

---

## FASE I — Reportes y observabilidad (opcional en v1)

1. Métricas desde `quotation_events`: carritos creados/retomados, tasa carrito → emitida → aceptada, ticket promedio, productos/planes más cotizados, tasa de abandono, entregas fallidas por canal.
2. Intenciones NL nuevas: `conteo-cotizaciones`, `tasa-aceptacion-cotizaciones`, `productos-mas-cotizados` (amplía las 22 de §18; actualizar `docs/natural-language-reports.md`).
3. Alerta si p95 de `quotation/*` > 300 ms.

---

## FASE J — Documentación

1. `docs/quotations-tech-manual.md` (vía `/doc-coauthoring`): tipos de partida, catálogo administrado y proyección de planes, máquina de estados, contrato de tools, identidad del contacto, redondeo, totales por modalidad, exportación `v1`, matriz de entrega, metering, retención.
2. Entrada **11** en `AGENTS.md` §17.
3. `db/schema.md`.

---

## Pruebas obligatorias (§9)

Toda prueba de rechazo con su contraparte de éxito.

**Aislamiento multi-tenant (innegociable)**
- Token de A con el teléfono de un contacto que solo existe en B → crea/usa un contacto y carrito **de A**, nunca toca el de B.
- `GET /quotations/:id` de B con sesión de A → 404; con sesión de B → 200.
- Búsqueda no devuelve variantes sin `catalog_access`; con catálogo compartido sí.
- RLS: `authenticated` de A no lee cotizaciones de B; no puede insertar/actualizar cotizaciones de nadie (ni las propias) directo por Supabase; el backend sí.

**Carrito por contacto (D2)**
- Conversación 1 agrega 2 partidas; conversación 2 (otro `conversationId`, mismo teléfono) → `view` devuelve las 2 partidas con `resumed: true`.
- Mismo contacto por voz y luego por WhatsApp → mismo carrito.
- Carrito `abandonada` (antes de la purga) se reabre al volver el contacto; contraparte: tras emitir, un `set-item` del mismo contacto crea un **carrito nuevo**.
- Canal `web` no retoma un carrito creado por voz solo con el correo.
- Dos `set-item` concurrentes del mismo contacto nuevo → un solo borrador.

**Idempotencia**
- `set-item` repetido → mismo estado. `finalize` repetido/paralelo → un folio, un job. Jobs re-ejecutados → un PDF, un envío por canal. Reintento de `finalize` tras emitir → mismo folio.

**Folios**
- 50 emisiones concurrentes → consecutivos sin huecos; organizaciones independientes; cambio de año; emisión fallida no avanza el contador.

**Cálculo (mutación ≥ 90 %)**
- IVA incluido/excluido, tasas mixtas, cantidades decimales, descuentos, half-up en el límite.
- Plan (único) + mantenimiento mensual → `totals_by_billing` con dos bloques y total inicial correcto.
- Monedas mezcladas → rechazo; misma moneda → total.
- `amountToSpokenSpanish`/`amountToLegalSpanish` con 0, 1, 21, 100, 1 000, 1 000 000, centavos.

**Tipos de partida y planes (B2)** — ver B2.6, más: servicio/plan no verbaliza existencias; producto sí. Plan con iguala "a medida" no se agrega al carrito; con precio sí.

**Inmutabilidad y estados** — trigger rechaza edición de emitida y permite en borrador; transiciones inválidas rechazadas, válidas aceptadas.

**Precio y disponibilidad** — cambio de precio entre `set-item` y `finalize` → `priceChanges`; override de sucursal respetado; variante inactiva rechazada; SKU duplicado resuelto de forma determinista.

**Entitlements** — `starter` sin tools; `pro` con tools; `pro` sin `product_rag` no sincroniza KB; job de entrega con feature retirada no envía; WhatsApp sin feature `whatsapp` → `omitido`.

**Retención (D3)**
- `purge_abandoned_quotations()` borra una `abandonada` más vieja que `retention_days`; **no** borra una `abandonada` reciente, ni una `emitida`, `vencida`, `cancelada` o `rechazada` vieja.

**Dependencias caídas** — Postgres lento en `set-item` → degradado verbalizable en presupuesto; Meta/Resend/SMTP caídos → la emisión ya respondió; la entrega queda `error` registrada.

**Canales y datos personales** — E.164 inválido no intenta WhatsApp; `opted_out` → `omitido`; fuera de ventana sin plantilla → `omitido`, con plantilla → enviado; ARCO anonimiza y conserva importes.

**Metering** — un envío de WhatsApp = un `usage_events` con tarifa vigente; reintento no duplica.

**PDF** — `%PDF` válido (`src/lib/magic-bytes.ts`), contiene folio, bloques por modalidad e importe con letra; 40 partidas → varias páginas.

---

## Pruebas de mutación (§10)

| Archivo | Categoría | Umbral |
|---|---|---|
| `quotation-math.ts`, `number-to-spanish-words.ts`, `quotation-folio.ts` | Cálculo de costos | ≥ 90 % (score total) |
| `entitlements.ts` (`hasCatalogAccess`), resolución de tenant y contacto en `tools/quotation.ts` | Seguridad y aislamiento | ≥ 90 % (score total) |
| `quotation-whatsapp.ts`, extensión de `email-dispatch.service.ts` | Integración | ≥ 80 % |
| `tools/quotation.ts`, `organization-quotations.ts`, `admin/plans.ts` (binding), jobs | Handlers y jobs | ≥ 75 % |

La lógica en SQL (proyección de planes, triggers, purga) se cubre con pruebas de integración contra la base real; Stryker no la muta — dejarlo explícito en el manual.

---

## Orden de implementación y coordinación con el frontend

| Paso | Backend | Frontend (tarea hermana) | Mergeable solo |
|---|---|---|---|
| 1 | **A + B** (feature, permisos, catálogo abierto a `pro`, H2, H3, H19) | F0 (gating del catálogo con `anyOf`) | Sí, juntos |
| 2 | — | **F1**: `publicPlanSchema` acepta `annualDiscountPct` y `catalogRefs` opcionales | **Debe ir antes del paso 3** (H18) |
| 3 | **B2** (tipos, catálogo administrado, proyección, contrato público ampliado) | F2 (tipos en catálogo), F3 (Pricing sin literal, admin de planes) | Sí |
| 4 | **C** (servicios puros) | — | Sí |
| 5 | **D** (tools, provisión, prompt) | — | Sí (probar con `docs/tunneling.md`) |
| 6 | **E + F** (PDF, jobs, correo; WhatsApp al final) | — | Sí |
| 7 | **G + H.1** | F4–F7 (módulo de cotizaciones) | Juntos |
| 8 | **I, J**, B2.5 (add-ons) | F8 (add-ons desde API) | Opcional |

Cada fase cierra con:

```bash
pnpm type-check && pnpm lint && pnpm test
pnpm stryker run          # fases C, D, F
docker build -t datagol-api:local .
trail build
```

---

## Decisiones abiertas restantes

| # | Decisión | Recomendación | Fase |
|---|---|---|---|
| D5 | Formato del folio | `{PREFIJO}-{AAAA}-{000000}`, reinicio anual, prefijo configurable | A |
| D6 | Totales en TypeScript o PL/pgSQL | TypeScript como fuente de verdad; SQL valida invariantes | C |
| D7 | Remitente de correo por defecto | `auto` | F |
| D8 | Plantilla de WhatsApp con documento | Plantilla base sugerida en el manual; cada tenant la aprueba en su WABA | F |
| D9 | ¿El catálogo de planes proyectado se comparte con sucursales/otras organizaciones del grupo? | No por defecto (`is_shared = false`); se puede compartir con el mecanismo existente de `catalog_access` | B2 |

---

## Evolución futura (no se construye en v1)

- **Etapa de pipeline `cotizado` (D4):** requiere ampliar el `CHECK` de `contacts.pipeline_stage` (`25_contacts_addresses.sql:31`) y su espejo en el frontend; disparada por la transición `emitida`/`enviada`, con fila en `contact_pipeline_transitions`. Evaluar con datos reales de `quotation_events` (cuántos contactos cotizados avanzan) antes de agregar la columna al Kanban.
- **Tabla `deals`** a partir de cotizaciones aceptadas (resuelve la limitación de `contacts.deal_value` de AGENTS §6).
- Remisión/factura CFDI, webhook saliente, aceptación electrónica por el consumidor (reutilizando `contract-otp-service.ts`), seguimiento automático de carritos abandonados por WhatsApp (feature y costo propios).

## Fuera de alcance

Pagos o ligas de pago; inventario en vivo o reservas; descuentos del agente; cualquier manejo de audio.
