## Table `organizations`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `name` | `varchar` |  |
| `email` | `varchar` |  Unique |
| `phone_number` | `varchar` |  Nullable |
| `created_at` | `timestamptz` |  Nullable |
| `updated_at` | `timestamptz` |  Nullable |
| `whatsapp_business_account_id` | `varchar` |  Nullable |
| `whatsapp_phone_number_id` | `varchar` |  Nullable |
| `cal_event_type_id` | `int4` |  Nullable |
| `integration_settings` | `jsonb` |  Nullable |
| `active_voice_provider` | `varchar` |  Nullable |
| `elevenlabs_agent_id` | `varchar` |  Nullable |
| `max_concurrent_calls` | `int4` |  Nullable |
| `silence_timeout_seconds` | `int4` |  Nullable |
| `max_call_duration_seconds` | `int4` |  Nullable |
| `kyc_status` | `varchar` |  Nullable |
| `plan_key` | `text` |  Nullable |
| `webhook_token` | `text` |  Nullable |
| `agent_reprovision_pending` | `bool` |  |
| `status` | `text` |  |
| `suspended_reason` | `text` |  Nullable |
| `suspended_at` | `timestamptz` |  Nullable |
| `retention_days` | `int4` |  |
| `widget_daily_session_limit` | `int4` |  |

## Table `knowledge_base`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `title` | `text` |  |
| `content` | `text` |  |
| `embedding` | `vector` |  Nullable |
| `metadata` | `jsonb` |  Nullable |
| `created_at` | `timestamptz` |  Nullable |

## Table `call_logs`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `provider_call_id` | `varchar` |  Nullable Unique |
| `caller_phone` | `varchar` |  Nullable |
| `agent_phone` | `varchar` |  Nullable |
| `call_type` | `varchar` |  Nullable |
| `duration_seconds` | `int4` |  Nullable |
| `transcript` | `text` |  Nullable |
| `summary` | `text` |  Nullable |
| `sentiment` | `varchar` |  Nullable |
| `status` | `varchar` |  Nullable |
| `cost` | `numeric` |  Nullable |
| `created_at` | `timestamptz` |  Nullable |
| `customer_address` | `text` |  Nullable |
| `customer_city` | `varchar` |  Nullable |
| `customer_state` | `varchar` |  Nullable |
| `customer_zip` | `varchar` |  Nullable |
| `customer_lat` | `numeric` |  Nullable |
| `customer_lng` | `numeric` |  Nullable |
| `customer_name` | `varchar` |  Nullable |
| `customer_email` | `varchar` |  Nullable |
| `contact_id` | `uuid` |  Nullable |
| `call_summary_sent_at` | `timestamptz` |  Nullable |
| `channel` | `text` |  Nullable |

## Table `appointments`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `call_log_id` | `uuid` |  Nullable |
| `customer_name` | `varchar` |  |
| `customer_email` | `varchar` |  Nullable |
| `customer_phone` | `varchar` |  Nullable |
| `start_time` | `timestamptz` |  |
| `end_time` | `timestamptz` |  |
| `cal_booking_id` | `varchar` |  Nullable |
| `status` | `varchar` |  Nullable |
| `created_at` | `timestamptz` |  Nullable |
| `service_address` | `text` |  Nullable |
| `latitude` | `numeric` |  Nullable |
| `longitude` | `numeric` |  Nullable |
| `contact_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  Nullable |
| `contact_address_id` | `uuid` |  Nullable |

## Table `organization_members`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `user_id` | `uuid` |  |
| `role` | `text` |  |
| `created_at` | `timestamptz` |  |

## Table `contacts`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `phone_e164` | `text` |  Nullable |
| `full_name` | `text` |  Nullable |
| `email` | `text` |  Nullable |
| `business_name` | `text` |  Nullable |
| `business_sector` | `text` |  Nullable |
| `opted_out` | `bool` |  |
| `opted_out_at` | `timestamptz` |  Nullable |
| `first_seen_at` | `timestamptz` |  |
| `last_seen_at` | `timestamptz` |  |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `lifecycle_stage` | `text` |  |
| `pipeline_stage` | `text` |  |
| `pipeline_updated_at` | `timestamptz` |  |
| `won_at` | `timestamptz` |  Nullable |
| `lost_reason` | `text` |  Nullable |
| `archived_at` | `timestamptz` |  Nullable |
| `last_activity_at` | `timestamptz` |  |

## Table `leads`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  Nullable |
| `channel` | `text` |  |
| `call_log_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  |
| `full_name` | `text` |  Nullable |
| `email` | `text` |  Nullable |
| `contact_phone` | `text` |  Nullable |
| `business_name` | `text` |  Nullable |
| `business_sector` | `text` |  Nullable |
| `inquiry_reason` | `text` |  Nullable |
| `plan_of_interest` | `text` |  Nullable |
| `call_volume` | `text` |  Nullable |
| `booked_appointment` | `bool` |  |
| `temperature` | `text` |  Nullable |
| `needs_followup` | `bool` |  |
| `followup_notes` | `text` |  Nullable |
| `followup_status` | `text` |  |
| `followup_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `hot_lead_notified_at` | `timestamptz` |  Nullable |
| `prospect_summary_sent_at` | `timestamptz` |  Nullable |
| `deprecated_pipeline_stage` | `text` |  Nullable |

## Table `usage_events`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `provider` | `text` |  |
| `unit_type` | `text` |  |
| `quantity` | `numeric` |  |
| `unit_rate_usd` | `numeric` |  |
| `amount_usd` | `numeric` |  Nullable |
| `conversation_id` | `text` |  Nullable |
| `call_log_id` | `uuid` |  Nullable |
| `occurred_at` | `timestamptz` |  |
| `created_at` | `timestamptz` |  |
| `metadata` | `jsonb` |  |
| `idempotency_key` | `text` |  Nullable |

## Table `provider_rates`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `provider` | `text` |  |
| `unit_type` | `text` |  |
| `unit_rate_usd` | `numeric` |  |
| `effective_from` | `timestamptz` |  |
| `effective_to` | `timestamptz` |  Nullable |
| `notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `webhook_events`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `provider` | `text` |  |
| `event_id` | `text` |  |
| `event_type` | `text` |  Nullable |
| `raw_payload` | `jsonb` |  |
| `processed_at` | `timestamptz` |  Nullable |
| `error` | `text` |  Nullable |
| `received_at` | `timestamptz` |  |

## Table `organization_secrets`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `secret_key` | `text` |  |
| `vault_secret_id` | `uuid` |  |
| `rotated_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `platform_admins`

Personal de Datagol con acceso transversal. Nivel support es de solo lectura.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `user_id` | `uuid` |  Unique |
| `level` | `text` |  |
| `created_at` | `timestamptz` |  |
| `created_by` | `uuid` |  Nullable |

## Table `features`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `key` | `text` | Primary |
| `name` | `text` |  |
| `description` | `text` |  Nullable |
| `category` | `text` |  |
| `requires_provider` | `text` |  Nullable |
| `has_cost_impact` | `bool` |  |
| `globally_disabled` | `bool` |  |
| `disabled_reason` | `text` |  Nullable |
| `sort_order` | `int4` |  |
| `created_at` | `timestamptz` |  |

## Table `plans`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `key` | `text` | Primary |
| `name` | `text` |  |
| `setup_fee_mxn` | `numeric` |  Nullable |
| `monthly_fee_mxn` | `numeric` |  Nullable |
| `max_concurrent_calls` | `int4` |  |
| `is_active` | `bool` |  |
| `sort_order` | `int4` |  |
| `created_at` | `timestamptz` |  |
| `target_audience` | `text` |  |
| `is_popular` | `bool` |  |
| `badge` | `text` |  Nullable |
| `setup_includes` | `_text` |  |
| `retainer_includes` | `_text` |  |
| `cta_text` | `text` |  |
| `show_retainer` | `bool` |  |

## Table `plan_features`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `plan_key` | `text` | Primary |
| `feature_key` | `text` | Primary |
| `enabled` | `bool` |  |

## Table `organization_features`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `feature_key` | `text` |  |
| `enabled` | `bool` |  |
| `reason` | `text` |  |
| `expires_at` | `timestamptz` |  Nullable |
| `granted_by` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `feature_audit_log`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `feature_key` | `text` |  Nullable |
| `action` | `text` |  |
| `previous_value` | `bool` |  Nullable |
| `new_value` | `bool` |  Nullable |
| `reason` | `text` |  Nullable |
| `actor_user_id` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `outbound_call_attempts`

Log de intentos de llamada saliente (exitosos o no) usado únicamente para aplicar el límite de tasa de /api/voice/outbound. RLS habilitada sin políticas: solo service_role (backend) la lee/escribe.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `target_phone_raw` | `text` |  |
| `source_ip` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `contact_addresses`

Direcciones físicas y fiscales. Cuando contact_id no es nulo, pertenece a ese contacto. Cuando contact_id es nulo, representa una sede/sucursal o matriz de la propia organización.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  Nullable |
| `label` | `text` |  Nullable |
| `address_type` | `text` |  |
| `is_primary` | `bool` |  |
| `street` | `text` |  |
| `interior` | `text` |  Nullable |
| `neighborhood` | `text` |  Nullable |
| `city` | `text` |  Nullable |
| `state` | `text` |  Nullable |
| `postal_code` | `text` |  Nullable |
| `country` | `text` |  |
| `latitude` | `numeric` |  Nullable |
| `longitude` | `numeric` |  Nullable |
| `dedupe_key` | `text` |  Nullable |
| `notes` | `text` |  Nullable |
| `verified_at` | `timestamptz` |  Nullable |
| `archived_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `contact_notes`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  |
| `body` | `text` |  |
| `author_user_id` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `organization_usage_alerts`

Registro de alertas de créditos de ElevenLabs (15%/10%/5% restante) ya enviadas por organización y ciclo de facturación — evita reenviar el mismo umbral dos veces dentro del mismo ciclo. RLS habilitada sin políticas: solo service_role la atraviesa.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `alert_type` | `text` |  |
| `cycle_reset_at` | `timestamptz` |  |
| `sent_at` | `timestamptz` |  |

## Table `whatsapp_messages`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  |
| `direction` | `text` |  |
| `body` | `text` |  |
| `wa_message_id` | `text` |  Nullable Unique |
| `sent_by_user_id` | `uuid` |  Nullable |
| `status` | `text` |  |
| `created_at` | `timestamptz` |  |

## Table `widget_origins`

Orígenes (esquema+host) autorizados a usar el widget de chat web de una organización, cada uno con su propia public_key no secreta. POST /api/widget/session valida el par (public_key, header Origin) exacto contra esta tabla antes de emitir un token efímero de conversación de ElevenLabs.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `origin` | `text` |  |
| `public_key` | `text` |  |
| `enabled` | `bool` |  |
| `created_at` | `timestamptz` |  |

## Table `widget_session_attempts`

Log de sesiones de widget concedidas (no de intentos rechazados por origen/entitlement) usado únicamente para el cortafuegos de costo de POST /api/widget/session: límite por IP/hora y por organización/día. RLS habilitada sin políticas: solo service_role (backend) la lee/escribe.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `source_ip` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## RLS Policies

### `organization_members`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `members_self_access` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `platform_admins`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admins_self_select` | SELECT | authenticated | PERMISSIVE | `(user_id = auth.uid())` | — |

### `leads`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `features`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `webhook_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read_webhooks` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `call_logs`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `plan_features`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `knowledge_base`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `plans`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `organization_features`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `admin_write_features` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |
| `tenant_read_features` | SELECT | public | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `appointments`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `feature_audit_log`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `audit_read` | SELECT | public | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `usage_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read_usage` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `organizations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `admin_delete_organizations` | DELETE | authenticated | PERMISSIVE | `is_platform_admin()` | — |
| `org_self_access` | ALL | authenticated | PERMISSIVE | `(id IN ( SELECT auth_organization_ids() AS auth_organization_ids))` | `(id IN ( SELECT auth_organization_ids() AS auth_organization_ids))` |

### `contact_notes`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | authenticated | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `contact_addresses`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | authenticated | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `contacts`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `whatsapp_messages`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `widget_origins`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

