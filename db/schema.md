## Table `organizations`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `name` | `varchar` |  |
| `email` | `varchar` |  Unique |
| `phone_number` | `varchar` |  Nullable |
| `deprecated_vapi_agent_id` | `varchar` |  Nullable |
| `created_at` | `timestamptz` |  Nullable |
| `updated_at` | `timestamptz` |  Nullable |
| `address` | `text` |  Nullable |
| `city` | `varchar` |  Nullable |
| `state` | `varchar` |  Nullable |
| `postal_code` | `varchar` |  Nullable |
| `latitude` | `numeric` |  Nullable |
| `longitude` | `numeric` |  Nullable |
| `deprecated_vapi_private_key` | `text` |  Nullable |
| `deprecated_vapi_phone_number_id` | `varchar` |  Nullable |
| `whatsapp_access_token` | `text` |  Nullable |
| `whatsapp_business_account_id` | `varchar` |  Nullable |
| `whatsapp_phone_number_id` | `varchar` |  Nullable |
| `cal_api_key` | `text` |  Nullable |
| `cal_event_type_id` | `int4` |  Nullable |
| `integration_settings` | `jsonb` |  Nullable |
| `active_voice_provider` | `varchar` |  Nullable |
| `elevenlabs_api_key` | `text` |  Nullable |
| `elevenlabs_agent_id` | `varchar` |  Nullable |
| `telnyx_api_key` | `text` |  Nullable |
| `telnyx_phone_number_id` | `varchar` |  Nullable |
| `telnyx_sip_connection_id` | `varchar` |  Nullable |
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
| `phone_e164` | `text` |  |
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
| `pipeline_stage` | `text` |  Nullable |

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

## RLS Policies

### `organization_members`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `members_self_access` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `contacts`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

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

### `appointments`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `organization_features`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `admin_write_features` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |
| `tenant_read_features` | SELECT | public | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `feature_audit_log`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `audit_read` | SELECT | public | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `organizations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `admin_delete_organizations` | DELETE | authenticated | PERMISSIVE | `is_platform_admin()` | — |
| `org_self_access` | ALL | authenticated | PERMISSIVE | `(id IN ( SELECT auth_organization_ids() AS auth_organization_ids))` | `(id IN ( SELECT auth_organization_ids() AS auth_organization_ids))` |

### `usage_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read_usage` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

