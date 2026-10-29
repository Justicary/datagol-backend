# Manual Técnico — Cotizaciones con Carrito Conversacional (Datagol Backend)

Documento hermano de [`docs/tasks/procedimiento-cotizaciones.md`](tasks/procedimiento-cotizaciones.md)
(el diseño y sus decisiones) y [`db/schema.md`](../db/schema.md). Este manual
cubre lo que necesita quien opere, configure o extienda el sistema de
cotizaciones: cómo se modela, qué contrato exponen las tools y el dashboard,
cómo se calculan los importes y qué garantías da cada pieza.

Migraciones: `76_catalog_item_types_and_plans_bridge.sql` (tipos de partida y
puente de planes) y `77_quotations.sql` (cotizaciones). Feature: `quotations`
(planes `pro`, `elite`, `enterprise`; `starter` denegado).

---

## 1. Principios que gobiernan el diseño

1. **El LLM elige; no calcula ni fija precios.** El agente solo dice *qué SKU*
   y *cuántas unidades*. Precio, impuestos y totales los calcula el servidor y
   regresan ya verbalizados (`spokenTotal`). El agente **nunca** aplica
   descuentos: solo un humano desde el dashboard, y únicamente sobre un
   borrador. Descontar algo ya emitido exige una revisión (`-R{n}`).
2. **El carrito es una cotización en `borrador` y pertenece al contacto.** No
   hay tabla de carrito aparte. Un solo borrador abierto por
   `(organization_id, contact_id)`; `conversation_id` es trazabilidad, no llave.
3. **El folio nace al emitir.** Los carritos abandonados no consumen folios ni
   dejan huecos.
4. **Emitida = inmutable.** Un trigger impide modificar partidas y cabecera
   tras emitir; corregir produce una revisión (`COT-2026-000123-R1`).
5. **Snapshot + IDs estables.** Cada partida guarda `variant_id`, `product_id`,
   `catalog_id`, `external_id`, claves SAT, tipo y modalidad de cobro **y** una
   copia de nombre, precio, moneda y tasa. Así una cotización puede convertirse
   en remisión o CFDI aunque el catálogo cambie o se borre.
6. **Ningún tercero dentro del tool call.** PDF, Storage, Resend, SMTP y Meta
   corren en pg-boss. `finalize` responde con el folio dentro del presupuesto
   de latencia (AGENTS §3).
7. **Escritura solo por el backend.** Las tablas de cotizaciones tienen RLS de
   **solo lectura** para `authenticated`; no existen políticas de escritura. La
   máquina de estados, los folios y el cálculo no se pueden saltar escribiendo
   directo desde el navegador.

---

## 2. Catálogo: tipos de partida y modalidad de cobro (migración 76)

### 2.1 Columnas nuevas

| Tabla | Columna | Regla |
|---|---|---|
| `products` | `item_type` | `producto` \| `servicio` \| `plan`. Backfill: todo lo existente quedó `producto`. |
| `products` | `is_inventoriable` | Generada: `item_type = 'producto'`. Nunca se captura. |
| `products` | `bundle_parent_id` | Servicio complementario de un plan (su mantenimiento). FK compuesta: mismo catálogo obligatorio. |
| `product_variants` | `billing_period` | `unico` \| `mensual` \| `anual` (mismo dominio que `deployments.billing_period`). |
| `product_variants` | `sat_unit_key` | `c_ClaveUnidad` para CFDI 4.0 (la captura el cliente). |
| `product_variants` | `stock_status` | Se agrega `no_aplica`. |

Módulos de constraint en TypeScript: `src/types/catalog-item-type.ts`,
`src/types/billing-period.ts`, `src/types/stock-status.ts`.

### 2.2 Trigger `enforce_variant_item_type`

- Servicio o plan (no inventariable) → `stock_status` se fuerza a `no_aplica`
  y `stock_note` a `null`.
- Producto → `no_aplica` se rechaza. Si un servicio se cambia a producto, sus
  variantes pasan a `sin_dato`.

Efecto en voz: `stockStatusToSpeech('no_aplica')` devuelve cadena vacía y las
tools omiten la disponibilidad. El agente no dice "creo que hay disponible" de
una consultoría.

### 2.3 Acceso al catálogo para `pro`

`hasCatalogAccess(features)` (`src/services/entitlements.ts`) = `product_rag`
**o** `quotations`, con una sola consulta de features. Lo usan
`routes/catalogs.ts` y `routes/tools/products.ts`.

La sincronización con la KB de ElevenLabs (`jobs/sync-catalog-kb.ts`) exige
**`product_rag`** al ejecutar. Un tenant `pro` con solo `quotations` carga y
cotiza su catálogo, pero no lo sincroniza a la KB.

Del lado de la base, `organization_has_catalog_feature(org_id)` se agregó a
las políticas de escritura de `products`, `product_variants`,
`catalog_custom_fields` y `catalog_imports`. Así la feature también es
autoritativa para las escrituras directas que hace el frontend con Supabase.

### 2.4 Resolución determinista de variante

`resolve_variant_for_org` ordena por `(owner_organization_id = p_org_id) DESC,
catalog_id`: el catálogo propio gana sobre uno compartido con el mismo SKU.
Devuelve además `variant_id`, `product_id`, `catalog_id`, `item_type`,
`is_inventoriable` y `billing_period`. Para no inventariables ignora el
override de existencias de la sucursal.

---

## 3. Planes de Datagol proyectados al catálogo

`plans` sigue siendo la **fuente de verdad**: además del precio, gobierna
entitlements, concurrencia, usuarios, buzones y el prompt. El catálogo es una
**proyección de solo lectura** en los campos de precio.

### 3.1 Vinculación (una vez, por superadmin)

- `POST /api/admin/plans/catalog-binding { organizationId }` crea el catálogo
  `Planes Datagol` con `managed_source = 'datagol_plans'` en la organización de
  la landing (la que el frontend conoce como `NEXT_PUBLIC_DEFAULT_ORG_ID`) y
  proyecta todos los planes.
- `GET /api/admin/plans/catalog-binding` devuelve el estado del vínculo.

A lo más existe un catálogo administrado por instalación (índice único
parcial). No hay variable de entorno: el vínculo vive en datos.

### 3.2 Qué se proyecta

Trigger `AFTER INSERT OR UPDATE OR DELETE ON plans` → `sync_plan_to_catalog`,
**en la misma transacción**:

| Partida | `external_id` | SKU | Precio |
|---|---|---|---|
| Plan (setup), `item_type = 'plan'` | `plan:{key}` | `PLAN-{KEY}` (`unico`) | `setup_fee_mxn` |
| Mantenimiento, `item_type = 'servicio'`, hijo del plan | `plan-retainer:{key}` | `MANT-{KEY}-MENSUAL` | `monthly_fee_mxn` |
| | | `MANT-{KEY}-ANUAL` | `round(monthly × (1 − annual_retainer_discount_pct)) × 12` |

Reglas:

- **Redondeo idéntico a la landing:** el mensual con descuento se redondea
  *antes* de multiplicar por 12, igual que la cifra por mes de `Pricing.tsx`.
- Todas las variantes: `MXN`, `price_includes_tax = false`, `tax_rate = 0.16`
  (la landing declara "precios más IVA").
- `monthly_fee_mxn` nulo ("iguala a medida") → variantes de mantenimiento con
  `price = null`; el agente responde que se cotiza con un asesor y la partida no
  entra al carrito.
- `show_retainer = false` → mantenimiento inactivo. Plan inactivo o borrado →
  ambos productos `is_active = false`. **Nunca se borran**: las cotizaciones
  emitidas los referencian por ID.
- Idempotente: upsert por `external_id`. El historial de precios registra
  `source = 'plans_sync'`.
- No se proyectan `max_concurrent_calls`, `max_users`, `max_mailboxes` ni
  `plan_features`.
- Sin catálogo vinculado, modificar `plans` no falla ni crea nada.

### 3.3 Bloqueo de campos administrados

Trigger `guard_managed_catalog_rows`: en un catálogo con `managed_source`,
fuera de la sesión de sincronización (`datagol.managed_sync = 'on'`) se rechaza
el `INSERT`/`DELETE` y la edición de `name`, `item_type`, `bundle_parent_id`,
`external_id`, `is_active`, `sku`, `price`, `currency`, `price_includes_tax`,
`tax_rate` y `billing_period`. Mensaje: *"Este campo se administra desde Planes
(/admin/plans)"*.

Siguen editables a mano: imagen, `description`, `keywords`, `sat_product_key`,
`sat_unit_key` y `custom_fields`. Es un trigger, no lógica del backend, porque
el frontend escribe el catálogo directo.

### 3.4 Contrato público

- `GET /api/plans/public` agrega `annualDiscountPct` y
  `catalogRefs: { setupSku, monthlySku, annualSku } | null`. **Orden de
  despliegue obligatorio:** el `publicPlanSchema` del frontend es `.strict()`,
  así que primero se despliega el frontend aceptando ambos campos como
  opcionales y después el backend.
- `PATCH /api/admin/plans/:key` acepta `annualRetainerDiscountPct` (0–0.9).
- `GET /api/plans/public/addons?organizationId=` expone los add-ons del
  catálogo por defecto con whitelist de columnas.
- El catálogo administrado se excluye de cualquier listado público de catálogo
  (`managed_source is null`): los planes ya tienen su sección de Pricing.

---

## 4. Modelo de datos de cotizaciones (migración 77)

| Tabla | Propósito |
|---|---|
| `quotation_settings` | Una fila por organización: prefijo de folio, vigencia (días), TTL del carrito (horas, default 168), tope de partidas, términos, remitente de correo, plantilla de WhatsApp. |
| `quotation_folio_counters` | `(organization_id, year) → last_value`. Se incrementa en la misma transacción que emite. |
| `quotations` | Cabecera: estado, contacto, snapshot del cliente, folio, revisión, totales, PDF, fechas de transición. |
| `quotation_items` | Partidas con snapshot. **Sin FK a `product_variants`** a propósito (ver abajo). |
| `quotation_deliveries` | Una fila por canal de envío, con llave de idempotencia única. |
| `quotation_events` | Bitácora append-only de todo lo que le pasa a una cotización. |

**Por qué las partidas no tienen FK a la variante:** `CASCADE` destruiría
cotizaciones emitidas, `SET NULL` perdería el ID que se debe conservar y
`RESTRICT` bloquearía el borrado de catálogos. La integridad se verifica al
insertar (solo variantes que `resolve_variant_for_org` resuelve para la
organización) y el snapshot hace a la partida autosuficiente.

### 4.1 Máquina de estados (`quotation_transition_allowed`)

```
borrador   → emitida | abandonada | cancelada
abandonada → borrador                       (el contacto regresa antes de la purga)
emitida    → enviada | aceptada | rechazada | vencida | cancelada
enviada    → aceptada | rechazada | vencida | cancelada
aceptada   → convertida                     (reservado para remisión/CFDI)
```

Las partidas solo se modifican en `borrador`. Una cotización emitida solo
cambia `status`, `status_reason`, las fechas de transición y los campos del
PDF mientras estén nulos.

### 4.2 Folios

Formato `{PREFIJO}-{AAAA}-{000000}`, reinicio anual, prefijo configurable
(`^[A-Z0-9]{1,8}$`, default `COT`). Revisiones: sufijo `-R{n}`
(`formatFolio` en `src/services/quotations/quotation-folio.ts`). El contador se
incrementa con `INSERT … ON CONFLICT DO UPDATE … RETURNING` dentro de la
transacción de emisión: si la emisión falla, el contador no avanza y no quedan
huecos.

### 4.3 RPCs (`security definer`)

| RPC | Uso |
|---|---|
| `quotation_cart_apply(org, contact, conversation, channel, op, sku, qty)` | `op ∈ set/remove/view`. Busca el borrador del contacto, reabre su `abandonada` más reciente o crea uno (`ON CONFLICT` sobre el índice parcial). Cantidad **absoluta** (`set 0` = eliminar). |
| `quotation_emit(org, quotation, customer, totals)` | `FOR UPDATE`. Si ya está emitida devuelve el folio existente. Re-resuelve precio y disponibilidad, reporta `priceChanges`, asigna folio, guarda snapshots y totales (validando invariantes). |
| `quotation_search_products(org, query, limit)` | `pg_trgm` sobre nombre, keywords, marca, SKU y presentación, restringida a `catalog_access`. Para un plan devuelve el SKU de su mantenimiento. |
| `purge_abandoned_quotations()` | Ver §9. |

---

## 5. Cálculo de importes (`src/services/quotations/quotation-math.ts`)

TypeScript es la fuente de verdad; la RPC de emisión solo valida invariantes
baratos (`total = Σ partidas`, coherencia por modalidad).

- **Centavos enteros.** Nunca se opera con flotantes sobre importes.
- Por partida, redondeo half-up a 2 decimales:
  - IVA incluido: `base = round(precio × cant / (1 + tasa))`, `iva = total − base`.
  - IVA excluido: `base = round(precio × cant)`, `iva = round(base × tasa)`.
  - El descuento se aplica sobre la base, antes de impuestos.
- Los totales son la suma de partidas (compatible con CFDI 4.0).
- **Totales por modalidad (`totals_by_billing`):** pago único, mensual y anual
  por separado. `total` = **total inicial** = pagos únicos + primer periodo de
  cada recurrente. Un plan con su mantenimiento mensual se verbaliza así:
  *"cuarenta y nueve mil pesos de pago único más tres mil novecientos noventa y
  nueve mensuales, más IVA"*.
- `tax_breakdown` agrupa por tasa.
- Monedas mezcladas en un carrito → error tipado `MIXED_CURRENCY`,
  verbalizable.

Importes en palabras (`src/lib/number-to-spanish-words.ts`):
`amountToSpokenSpanish(cents, currency)` para voz y
`amountToLegalSpanish(cents, currency)` para el "importe con letra" del PDF
(`(MIL OCHOCIENTOS CINCUENTA PESOS 50/100 M.N.)`).

---

## 6. Tools en vivo (`src/routes/tools/quotation.ts`)

Autenticación por `webhookToken` + `x-tool-secret`. El tenant sale del token,
**nunca** del body. Zod en body y respuesta, `withToolTimeout`, y siempre HTTP
200 con un mensaje verbalizable, incluso en degradado.

| Tool (ElevenLabs) | Ruta | Body |
|---|---|---|
| `quotation_search` | `POST /tools/:webhookToken/quotation/search` | `{ query, limit? ≤ 3 }` |
| `quotation_cart_set_item` | `POST …/quotation/cart/set-item` | `{ conversationId, customerPhone?, customerEmail?, customerName?, sku, quantity }` |
| `quotation_cart_remove_item` | `POST …/quotation/cart/remove-item` | `{ conversationId, customerPhone?, customerEmail?, sku }` |
| `quotation_cart_view` | `POST …/quotation/cart/view` | `{ conversationId, customerPhone?, customerEmail? }` |
| `quotation_finalize` | `POST …/quotation/finalize` | `{ conversationId, customerPhone?, customerEmail?, customerName, channels: ('email'\|'whatsapp')[] }` |

Las cinco se registran en el agente solo si la organización tiene `quotations`
(`src/services/agent-provisioning.ts`). El bloque de instrucciones del prompt
vive en `src/lib/agent-prompts.ts`.

### 6.1 Identidad del contacto

- Cada llamada resuelve el contacto con `resolveContactBestEffort` → RPC
  `resolve_contact` (teléfono E.164 → correo → contacto nuevo), siempre dentro
  de la organización del token.
- Si dos tool calls simultáneos llegan con un teléfono nuevo, el que pierde la
  carrera del `insert` recibe `unique_violation` y se reintenta una vez; el
  reintento encuentra el contacto creado por el otro.
- Sin teléfono ni correo → `MISSING_CONTACT`: el agente pide un dato. No se
  crean carritos anónimos.
- **El LLM no debe inventar el teléfono.** En ElevenLabs, `customerPhone` se
  configura como *Dynamic Variable* `system__caller_id`, no como parámetro que
  el LLM rellena. Detalle en `docs/elevenlabs-endpoints-manual.md`.
- **Riesgo residual en web chat:** ahí el correo lo dicta el usuario. Un
  tercero que dicte el correo de otro podría ver su carrito (solo SKU,
  cantidades y total, sin datos personales). Mitigación: `view` en canal `web`
  solo retoma carritos cuyo último canal fue `web` y con actividad de menos de
  24 h. Para retomar entre canales hace falta teléfono.

### 6.2 Reglas de comportamiento

- **Cantidad absoluta.** Un reintento deja el mismo estado. "Agrega dos más" lo
  resuelve el LLM sumando sobre la cantidad del carrito previo.
- **`finalize` idempotente.** Si el contacto ya no tiene borrador pero tiene una
  cotización emitida con el mismo `conversationId` y `issued_at` dentro de los
  últimos 30 minutos,
  devuelve ese folio en vez de "carrito vacío".
- Canal sin dato (WhatsApp sin teléfono, correo sin email) → `MISSING_PHONE` /
  `MISSING_EMAIL`, para pedirlo antes de emitir.
- Al agregar un `plan`, la respuesta trae `suggestedComplement` (SKU del
  mantenimiento mensual) para ofrecerlo como opcional; nunca se agrega solo.
- `resumed: true` cuando el carrito viene de otra conversación; el resumen
  verbal incluye la frase de retoma.

### 6.3 Códigos de error verbalizables

| Código | Cuándo |
|---|---|
| `FEATURE_DISABLED` | La organización no tiene `quotations`. |
| `MISSING_CONTACT`, `MISSING_PHONE`, `MISSING_EMAIL` | Falta dato de identidad o del canal. |
| `SKU_NOT_FOUND`, `SKU_REQUIRED`, `VARIANT_UNAVAILABLE` | SKU inexistente, ausente o inactivo. |
| `OUT_OF_STOCK`, `CUSTOM_PRICE` | Agotado o precio "a medida" al agregar. |
| `ITEM_OUT_OF_STOCK`, `ITEM_CUSTOM_PRICE`, `ITEM_UNAVAILABLE` | Lo mismo, detectado al re-resolver en `finalize`. |
| `MAX_ITEMS_EXCEEDED` | Se rebasa `quotation_settings.max_items`. |
| `MIXED_CURRENCY` | Partidas con monedas distintas. |
| `EMPTY_CART` | `finalize` sin partidas. |
| `DEGRADED` | Timeout o falla de base de datos: mensaje verbalizable dentro del presupuesto. |

---

## 7. PDF (`src/services/quotations/quotation-pdf.ts`)

`renderQuotationPdf(data): Promise<Buffer>` es pura (sin red ni base de datos),
con `pdfkit`. Contiene:

- Datos y color de la organización.
- Folio y revisión.
- Fechas de emisión y vigencia en la zona horaria de la organización.
- Datos del cliente.
- Tabla de partidas: #, SKU, descripción, cantidad, precio unitario, importe y
  modalidad.
- Bloques de totales por modalidad, desglose de IVA y total inicial.
- Importe con letra.
- Notas y condiciones.
- La leyenda *"Cotización — no es comprobante fiscal"*.

Pagina con el encabezado repetido. No lleva imágenes en v1.

El PDF se guarda en el bucket privado `quotations`, con la ruta
`{organization_id}/{folio_year}/{folio}.pdf` y su `pdf_sha256`. Se accede
solo con URLs firmadas generadas bajo demanda.

---

## 8. Jobs y entrega (`src/jobs/`)

| Cola | Disparo | Qué hace |
|---|---|---|
| `generate-quotation-pdf` | `finalize` y emisión desde el dashboard | Verifica `quotations` al ejecutar. No regenera si ya hay PDF. Crea `quotation_deliveries` (`ON CONFLICT DO NOTHING`) y encola una entrega por canal. |
| `deliver-quotation` | El job anterior y el reenvío del dashboard | Sale sin efecto si la entrega ya está `enviado`. El primer envío exitoso mueve `emitida → enviada`. |
| `sweep-quotations` | Scheduler pg-boss, cada hora (`0 * * * *` UTC) | `borrador` sin actividad por más de `cart_ttl_hours` → `abandonada`. `emitida`/`enviada` con `valid_until` vencido → `vencida`. |

Estados de una **entrega** (`quotation_deliveries.status`, distintos de los de
la cotización): `pendiente`, `enviado`, `error` y `omitido` (con
`skip_reason`). Se consultan en el detalle del dashboard
(`GET …/quotations/:quotationId`).

Las tres colas usan `retryLimit: 3` con backoff. Al agotarse los reintentos,
la entrega queda `error` y se registra con `tenant_id`, `quotation_id` y
`conversation_id`.

### 8.1 Matriz de entrega

**Correo** (según `quotation_settings.email_sender`):

| Valor | Comportamiento |
|---|---|
| `mailbox` | Buzón propio vía `dispatchOrSaveDraft`, ahora con adjuntos. Exige buzón activo y la feature `email_integration`. |
| `resend` | Resend, con `replyTo` de la organización. |
| `auto` (default) | `mailbox` si hay buzón activo y `email_integration`; si no, `resend`. |

El PDF va adjunto si pesa hasta 7 MB. Si pesa más, se envía un enlace firmado
con vigencia de 7 días.

**WhatsApp** (`src/services/quotations/quotation-whatsapp.ts`):

| Condición | Resultado |
|---|---|
| Sin feature `whatsapp` | `omitido` (`whatsapp_feature_deshabilitada`) |
| Teléfono no E.164 | `omitido` (`telefono_e164_invalido`) |
| Contacto `opted_out` | `omitido` (`contacto_opted_out`) |
| Sin configuración o credenciales | `omitido` (`sin_configuracion_whatsapp` / `sin_credenciales_whatsapp`) |
| Dentro de la ventana de 24 h | Mensaje `type: 'document'` con enlace firmado de 24 h (Meta descarga el archivo al enviar; el cliente no depende del enlace), `{folio}.pdf` y caption con folio y total |
| Fuera de la ventana, con `whatsapp_template_name` | Plantilla con encabezado de documento |
| Fuera de la ventana, sin plantilla | `omitido` (`fuera_de_ventana_sin_plantilla`) |

Cada envío queda registrado en `whatsapp_messages`.

### 8.2 Metering (AGENTS §6)

Cada mensaje de WhatsApp genera un asiento en `usage_events`:

- **Proveedor:** `meta`.
- **`unit_type`:** `wa_service_mx` dentro de la ventana, `wa_utility_mx` con
  plantilla.
- **Tarifa:** `getRate(...)` vigente al momento del envío, desde
  `provider_rates`.
- **`idempotency_key`:** `wa-quotation:{waMessageId}`, así que un reintento no
  duplica el asiento.

Resend no se mide hoy, consistente con el resto del sistema.

---

## 9. Retención (decisión D3)

`purge_abandoned_quotations()` corre a diario con `pg_cron` (`15 3 * * *`).
Borra **solo** cotizaciones `abandonada` cuya última actividad supera
`organizations.retention_days` (la misma retención que el contenido de
llamadas; 90 días si es nulo); partidas y eventos caen en cascada.
Devuelve `{ abandoned_quotations_purged, ran_at }`.

**Ningún otro estado se purga.** Las cotizaciones emitidas, enviadas,
aceptadas, rechazadas, vencidas, canceladas y convertidas se conservan.

El *sweep* cambia estado y la *purga* borra. Están separados a propósito.

**ARCO:** `erase_contact_pii` anonimiza `customer_*` de las cotizaciones del
contacto y `recipient` de sus entregas, conserva folio e importes y elimina su
borrador abierto. La versión vigente es la de la migración 79: la 77 había perdido la purga de transcripciones y la redacción de webhooks de la migración 17.

---

## 10. API del dashboard (`src/routes/organization-quotations.ts`)

Sesión de Supabase, `organizationId` verificado contra membresía, y permiso y
feature `quotations` verificados en el servidor.

| Ruta | Permiso |
|---|---|
| `GET /api/organizations/:id/quotations` (filtros `status`, `from`, `to`, `contactId`, `q`) | `view_quotations` |
| `GET …/quotations/:quotationId` (detalle, partidas, entregas, eventos) | `view_quotations` |
| `GET …/quotations/:quotationId/pdf` (URL firmada corta) | `view_quotations` |
| `GET …/contacts/:contactId/quotations` (historial y carrito abierto) | `view_quotations` |
| `GET …/catalog/search?q=` | `view_quotations` |
| `GET` / `PUT …/quotation-settings` | `view_quotations` / `manage_quotations` |
| `POST …/quotations` (borrador; 409 con su id si el contacto ya tiene uno) | `manage_quotations` |
| `PUT …/quotations/:quotationId/items` (reemplaza partidas, incluye descuentos) | `manage_quotations` |
| `POST …/quotations/:quotationId/emit` · `/send` · `/status` · `/revise` | `manage_quotations` |
| `GET …/quotations/export?format=json\|csv\|xlsx` | `export_data` |

Al marcar una cotización `aceptada`, la respuesta sugiere `suggestedDealValue`
(el total inicial), pero **no** escribe `contacts.deal_value`. Eso sigue en
`PATCH …/contacts/:contactId/pipeline`.

### 10.1 Exportación `datagol.quotation.v1`

- **`json`:** `{ schema: 'datagol.quotation.v1', quotations: [...] }`, con
  todos los IDs, `item_type`, `billing_period` y `sat_unit_key` de cada
  partida.
- **`csv` / `xlsx`:** una fila por partida (`xlsx` con `exceljs`).
- **Tope:** 2000 cotizaciones por exportación.
- **Bitácora:** cada exportación registra el evento `exportada`.

**Contrato futuro (no construido):**

- Conversión `aceptada → convertida` hacia `sales_documents`, con
  `source_quotation_id` y `source_quotation_item_id`.
- Las partidas recurrentes generarán un documento por periodo; por eso se
  conserva `billing_period`.
- Un CFDI necesitará los datos fiscales del receptor, que la cotización no
  pide.

---

## 11. Reportes en lenguaje natural

Tres intenciones nuevas amplían el catálogo de AGENTS §18:

- `conteo-cotizaciones`
- `tasa-aceptacion-cotizaciones`
- `productos-mas-cotizados`

Se calculan desde `quotations`, `quotation_items` y `quotation_events`, con
periodos en la zona horaria de la organización. Ver
`docs/natural-language-reports.md`.

---

## 12. Entitlements y permisos

- **Feature `quotations`:** `requires_provider = null` y
  `has_cost_impact = false`. WhatsApp lo gobierna su propia feature, que se
  verifica al enviar, no al encolar.
- **Puntos de verificación:**
  - provisión del agente (qué tools se registran);
  - cada tool call, después de autenticar;
  - cada job, al ejecutar;
  - cada ruta del dashboard.
- **Permisos:**

  | Permiso | Grupo | Roles |
  |---|---|---|
  | `view_quotations` | `datos` | owner, admin, member, viewer |
  | `manage_quotations` | `operacion` | owner, admin, member |

  La exportación usa `export_data`.
- `factory_reset_transactional_data()` incluye las tablas nuevas y reinicia
  los folios.

---

## 13. Pruebas y mutación

| Archivo de prueba | Cubre |
|---|---|
| `__tests__/quotation-math.test.ts` | IVA incluido y excluido, tasas mixtas, decimales, descuentos, half-up, totales por modalidad, monedas mezcladas |
| `__tests__/quotation-pure-services-edges.test.ts` | Límites de validación, mensajes de error, normalización de moneda, folios, vigencia en zona local y frases del resumen hablado |
| `__tests__/number-to-spanish-words.test.ts` | Importes hablados y con letra (0, 1, 21, 100, 1 000, 1 000 000, centavos) |
| `__tests__/catalog-b-b2-plans-bridge.test.ts` | Tipos de partida, triggers, proyección de planes, paridad con la landing, bloqueo de campos administrados, contrato público |
| `__tests__/quotation-constraints.test.ts` | Módulos de constraint sincronizados con la base real (feature, permisos, dominios) |
| `__tests__/quotation-state-machine.test.ts` | Transiciones válidas e inválidas, inmutabilidad de partidas, cabecera y PDF tras emitir, eventos append-only |
| `__tests__/quotation-tools.test.ts` | Tools en vivo, aislamiento multi-tenant, carrito por contacto entre conversaciones y canales, concurrencia, idempotencia de `finalize`, folios concurrentes sin huecos |
| `__tests__/quotation-pdf.test.ts` | `%PDF` válido, folio, bloques por modalidad, importe con letra, multipágina |
| `__tests__/quotation-jobs-delivery.test.ts` | Jobs, matriz de entrega, metering sin duplicados |
| `__tests__/organization-quotations-routes.test.ts` | API del dashboard, RLS, exportación, ARCO, retención |

**Stryker** muta los servicios de cálculo:

- `quotation-math.ts`
- `quotation-folio.ts`
- `quotation-cart-summary.ts`
- `quotation-validity.ts`
- `number-to-spanish-words.ts`

El umbral es ≥ 90 %. La lógica en SQL (proyección de planes, triggers,
máquina de estados, purga) se cubre con pruebas de integración contra la base
real; **Stryker no la muta**.

---

## 14. Fuera de v1 / evolución

- **Etapa de pipeline `cotizado` (D4):** evaluar con datos reales de
  `quotation_events` antes de agregarla.
- **Tabla `deals`** a partir de cotizaciones aceptadas.
- **Remisión/CFDI.**
- **Webhook saliente** (`quotation.emitted`, `quotation.accepted`).
- **Aceptación electrónica** por el consumidor.
- **Seguimiento automático** de carritos abandonados.
- **Fuera de alcance:** pagos, inventario en vivo y descuentos del agente.
