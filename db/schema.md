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
| `timezone` | `text` |  |
| `max_mailboxes` | `int4` |  Nullable |
| `credential_group_id` | `uuid` |  |

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
| `status` | `varchar` |  |
| `created_at` | `timestamptz` |  Nullable |
| `service_address` | `text` |  Nullable |
| `latitude` | `numeric` |  Nullable |
| `longitude` | `numeric` |  Nullable |
| `contact_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  Nullable |
| `contact_address_id` | `uuid` |  Nullable |
| `status_updated_at` | `timestamptz` |  Nullable |
| `status_updated_by` | `uuid` |  Nullable |
| `no_show_reason` | `text` |  Nullable |
| `confirmation_requested_at` | `timestamptz` |  Nullable |

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
| `deal_value` | `numeric` |  Nullable |
| `deal_currency` | `text` |  |
| `deal_notes` | `text` |  Nullable |

## Table `leads`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  Nullable |
| `channel` | `text` |  |
| `call_log_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  Nullable |
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
| `source` | `text` |  Nullable |
| `source_detail` | `text` |  Nullable |

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
| `max_users` | `int4` |  |
| `max_mailboxes` | `int4` |  Nullable |
| `annual_retainer_discount_pct` | `numeric` |  |

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

## Table `organization_attachments`

Documentos (PDF, DOCX, XLSX) cargados por la organización en bucket privado de Supabase Storage para adjuntar a agradecimientos automáticos. Solo uno activo por organización.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `file_name` | `text` |  |
| `mime_type` | `text` |  |
| `size_bytes` | `int8` |  |
| `storage_path` | `text` |  |
| `is_active` | `bool` |  |
| `uploaded_by` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |
| `archived_at` | `timestamptz` |  Nullable |

## Table `thank_you_sends`

Historial de envíos y omisiones de agradecimiento automático. Permite la deduplicación por ventana móvil y diagnóstico de prospectos omitidos.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  |
| `lead_id` | `uuid` |  Nullable |
| `channel` | `text` |  |
| `status` | `text` |  |
| `skip_reason` | `text` |  Nullable |
| `attachment_id` | `uuid` |  Nullable |
| `sent_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `weekly_reports`

Reportes semanales generados (planificación/ejecutivo). Fila de idempotencia (UNIQUE organization_id/report_type/week_start) y metadata de descarga (storage_path en el bucket organization-reports) a la vez.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `report_type` | `text` |  |
| `week_start` | `date` |  |
| `status` | `text` |  |
| `data` | `jsonb` |  |
| `narrative` | `text` |  Nullable |
| `storage_path` | `text` |  Nullable |
| `file_size_bytes` | `int4` |  Nullable |
| `delivery_log` | `jsonb` |  |
| `error` | `text` |  Nullable |
| `generated_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `contact_pipeline_transitions`

Historial de cambios de contacts.pipeline_stage, capturado por trigger. Alimenta "movimiento de pipeline" del reporte ejecutivo semanal.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  |
| `from_stage` | `text` |  Nullable |
| `to_stage` | `text` |  |
| `changed_at` | `timestamptz` |  |

## Table `competitor_sites`

Sitios de la competencia vigilados semanalmente por organización (máx. 3, aplicado en routes/organization-competitor-sites.ts). Fase C de docs/tasks/reportes-semanales.md.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `url` | `text` |  |
| `label` | `text` |  Nullable |
| `enabled` | `bool` |  |
| `last_checked_at` | `timestamptz` |  Nullable |
| `last_error` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `competitor_site_snapshots`

Instantánea semanal de texto extraído por sitio (nunca HTML crudo). UNIQUE (competitor_site_id, week_start) es la idempotencia "un acceso por sitio por semana" de C.2. Solo service_role escribe.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `competitor_site_id` | `uuid` |  |
| `organization_id` | `uuid` |  |
| `week_start` | `date` |  |
| `fetch_status` | `text` |  |
| `extracted_text` | `text` |  Nullable |
| `error` | `text` |  Nullable |
| `checked_at` | `timestamptz` |  |

## Table `unanswered_questions`

Bitácora de preguntas que el módulo de reportes en lenguaje natural no pudo resolver, requirieron aclaración o produjeron error.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `question` | `text` |  |
| `reason` | `text` |  |
| `metadata` | `jsonb` |  |
| `created_at` | `timestamptz` |  |

## Table `permissions`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `key` | `text` | Primary |
| `name` | `text` |  |
| `description` | `text` |  Nullable |
| `category` | `text` |  |
| `is_sensitive` | `bool` |  |
| `sort_order` | `int4` |  |
| `created_at` | `timestamptz` |  |

## Table `role_permissions`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `role` | `text` | Primary |
| `permission_key` | `text` | Primary |
| `enabled` | `bool` |  |

## Table `organization_role_permissions`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `role` | `text` |  |
| `permission_key` | `text` |  |
| `enabled` | `bool` |  |
| `reason` | `text` |  |
| `expires_at` | `timestamptz` |  Nullable |
| `granted_by` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `permission_audit_log`

Append-only (sin `UPDATE`/`DELETE`), salvo el `SET NULL` de `organization_id` (migración 47) y de `target_user_id`/`actor_user_id` al borrar un usuario (migración 81).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Nullable |
| `role` | `text` |  Nullable |
| `permission_key` | `text` |  Nullable |
| `action` | `text` |  |
| `previous_value` | `bool` |  Nullable |
| `new_value` | `bool` |  Nullable |
| `target_user_id` | `uuid` |  Nullable |
| `reason` | `text` |  Nullable |
| `actor_user_id` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `organization_invitations`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `email` | `text` |  |
| `role` | `text` |  |
| `token_hash` | `text` |  Unique |
| `invited_by` | `uuid` |  Nullable |
| `expires_at` | `timestamptz` |  |
| `accepted_at` | `timestamptz` |  Nullable |
| `revoked_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `email_accounts`

Buzones IMAP/SMTP vinculados por organización (docs/tasks/native-mail-integration.md). Credenciales en Supabase Vault vía vault_secret_id, no en esta tabla ni en organization_secrets.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `email_address` | `text` |  |
| `provider_label` | `text` |  Nullable |
| `imap_host` | `text` |  |
| `imap_port` | `int4` |  |
| `imap_secure` | `bool` |  |
| `imap_username` | `text` |  |
| `smtp_host` | `text` |  |
| `smtp_port` | `int4` |  |
| `smtp_secure` | `bool` |  |
| `smtp_username` | `text` |  |
| `vault_secret_id` | `uuid` |  |
| `status` | `text` |  |
| `last_validated_at` | `timestamptz` |  Nullable |
| `last_error` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `email_outbox`

Borradores y bitácora de envío de correo por organización, con clave de idempotencia UNIQUE (organization_id, idempotency_key) — AGENTS.md §4.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `email_account_id` | `uuid` |  |
| `idempotency_key` | `text` |  |
| `to_addresses` | `_text` |  |
| `cc_addresses` | `_text` |  Nullable |
| `subject` | `text` |  |
| `body_text` | `text` |  |
| `body_html` | `text` |  Nullable |
| `contact_id` | `uuid` |  Nullable |
| `status` | `text` |  |
| `provider_message_id` | `text` |  Nullable |
| `error_message` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `sent_at` | `timestamptz` |  Nullable |
| `attachments` | `jsonb` |  Nullable |
| `reply_to` | `text` |  Nullable |

## Table `elevenlabs_plans`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `key` | `text` | Primary |
| `name` | `text` |  |
| `max_concurrent` | `int4` |  |
| `monthly_credits_amount` | `int4` |  |
| `minutes_per_month` | `int4` |  |
| `notes` | `text` |  Nullable |
| `updated_at` | `timestamptz` |  |

## Table `credential_groups`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `name` | `text` |  |
| `owner_organization_id` | `uuid` |  Nullable |
| `elevenlabs_plan_key` | `text` |  Nullable |
| `concurrency_override` | `int4` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `webhook_token` | `text` |  Nullable |

## Table `organization_concurrency_quota`

Reparto informativo del pozo del grupo. Al rebasarse se avisa; nunca se rechaza una llamada.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `organization_id` | `uuid` | Primary |
| `soft_limit` | `int4` |  |
| `notes` | `text` |  Nullable |
| `updated_at` | `timestamptz` |  |

## Table `catalogs`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `owner_organization_id` | `uuid` |  |
| `name` | `text` |  |
| `description` | `text` |  Nullable |
| `is_shared` | `bool` |  |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `kb_folder_id` | `text` |  Nullable |
| `managed_source` | `text` |  Nullable, Unique (parcial) |

## Table `catalog_access`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `catalog_id` | `uuid` | Primary |
| `organization_id` | `uuid` | Primary |
| `can_edit` | `bool` |  |
| `granted_at` | `timestamptz` |  |

## Table `products`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `catalog_id` | `uuid` |  |
| `name` | `text` |  |
| `brand` | `text` |  Nullable |
| `category` | `text` |  Nullable |
| `description` | `text` |  Nullable |
| `active_components` | `text` |  Nullable |
| `suggested_use` | `text` |  Nullable |
| `contraindications` | `text` |  Nullable |
| `keywords` | `text` |  Nullable |
| `sat_product_key` | `text` |  Nullable |
| `is_active` | `bool` |  |
| `external_id` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `image_path` | `text` |  Nullable |
| `image_mime_type` | `text` |  Nullable |
| `image_size_bytes` | `int8` |  Nullable |
| `image_uploaded_at` | `timestamptz` |  Nullable |
| `custom_fields` | `jsonb` |  |
| `item_type` | `text` |  |
| `is_inventoriable` | `bool` |  Generated (`item_type = 'producto'`) |
| `bundle_parent_id` | `uuid` |  Nullable |

## Table `product_variants`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `product_id` | `uuid` |  |
| `catalog_id` | `uuid` |  |
| `sku` | `text` |  |
| `presentation` | `text` |  Nullable |
| `barcode` | `text` |  Nullable |
| `price` | `numeric` |  Nullable |
| `currency` | `text` |  |
| `price_includes_tax` | `bool` |  |
| `tax_rate` | `numeric` |  |
| `stock_status` | `text` |  |
| `stock_note` | `text` |  Nullable |
| `is_active` | `bool` |  |
| `price_changed_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `custom_fields` | `jsonb` |  |
| `billing_period` | `text` |  |
| `sat_unit_key` | `text` |  Nullable |

## Table `variant_price_history`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `variant_id` | `uuid` |  |
| `price` | `numeric` |  Nullable |
| `currency` | `text` |  Nullable |
| `changed_at` | `timestamptz` |  |
| `changed_by` | `uuid` |  Nullable |
| `source` | `text` |  Nullable |

## Table `organization_variant_overrides`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `organization_id` | `uuid` | Primary |
| `variant_id` | `uuid` | Primary |
| `price` | `numeric` |  Nullable |
| `stock_status` | `text` |  Nullable |
| `stock_note` | `text` |  Nullable |
| `is_available` | `bool` |  |
| `updated_at` | `timestamptz` |  |

## Table `product_kb_sync`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `product_id` | `uuid` | Primary |
| `credential_group_id` | `uuid` | Primary |
| `kb_document_id` | `text` |  Nullable |
| `synced_content_hash` | `text` |  Nullable |
| `synced_at` | `timestamptz` |  Nullable |
| `rag_indexed_at` | `timestamptz` |  Nullable |
| `status` | `text` |  |
| `error` | `text` |  Nullable |
| `attempts` | `int4` |  |
| `updated_at` | `timestamptz` |  |

## Table `catalog_imports`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `catalog_id` | `uuid` |  |
| `file_name` | `text` |  Nullable |
| `mode` | `text` |  |
| `status` | `text` |  |
| `rows_total` | `int4` |  |
| `rows_created` | `int4` |  |
| `rows_updated` | `int4` |  |
| `rows_failed` | `int4` |  |
| `column_mapping` | `jsonb` |  |
| `errors` | `jsonb` |  |
| `created_by` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |
| `completed_at` | `timestamptz` |  Nullable |

## Table `concurrency_quota_alerts`

Aviso (no bloqueo) de que una organización rebasó su organization_concurrency_quota.soft_limit dentro del pozo compartido del grupo. RLS habilitada sin políticas: solo service_role la escribe/lee, mismo patrón que organization_usage_alerts (migración 31).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `credential_group_id` | `uuid` |  |
| `current_count` | `int4` |  |
| `soft_limit` | `int4` |  |
| `alert_date` | `date` |  |
| `sent_at` | `timestamptz` |  |

## Table `catalog_import_mappings`

Mapeos de columnas de importación guardados y reutilizables (src/routes/catalogs.ts, GET/POST .../import-mappings). No participa en la aplicación del import — solo precarga columnMapping en el formulario.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `catalog_id` | `uuid` |  |
| `name` | `text` |  |
| `mode` | `text` |  |
| `column_mapping` | `jsonb` |  |
| `created_by` | `uuid` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `catalog_custom_fields`

Definiciones de campos personalizados por catálogo para productos y variantes (src/routes/catalogs.ts). Soporta tipos text, number, boolean y select, con bandera include_in_rag para inyección automática en ElevenLabs.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `catalog_id` | `uuid` |  |
| `entity_type` | `text` |  |
| `name` | `text` |  |
| `key` | `text` |  |
| `field_type` | `text` |  |
| `options` | `jsonb` |  |
| `description` | `text` |  Nullable |
| `is_required` | `bool` |  |
| `include_in_rag` | `bool` |  |
| `order_index` | `int4` |  |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `appointment_waitlist`

Cola de espera de citas (docs/tasks/waitlist_confirmacion_masiva.md). Matchmaking en src/services/waitlist-engine.ts; confirmación por enlace de un clic en src/routes/public/waitlist-confirmation.ts (offer_token_hash), con voz saliente como respaldo.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `contact_id` | `uuid` |  Nullable |
| `call_log_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  Nullable |
| `customer_name` | `text` |  |
| `customer_phone` | `text` |  |
| `customer_email` | `text` |  Nullable |
| `party_size` | `int4` |  |
| `preferred_date_start` | `date` |  |
| `preferred_date_end` | `date` |  |
| `preferred_time_start` | `time` |  Nullable |
| `preferred_time_end` | `time` |  Nullable |
| `status` | `text` |  |
| `priority` | `text` |  |
| `offered_appointment_id` | `uuid` |  Nullable |
| `offered_at` | `timestamptz` |  Nullable |
| `offer_expires_at` | `timestamptz` |  Nullable |
| `offer_token_hash` | `text` |  Nullable Unique |
| `offer_viewed_at` | `timestamptz` |  Nullable |
| `notification_channel` | `text` |  |
| `notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `offered_slot_start` | `timestamptz` |  Nullable |
| `offered_slot_end` | `timestamptz` |  Nullable |

## Table `license_client_state`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `bool` | Primary |
| `singleton` | `bool` |  Unique |
| `token` | `text` |  Nullable |
| `key_version` | `text` |  Nullable |
| `deployment_id` | `text` |  Nullable |
| `expires_at` | `timestamptz` |  Nullable |
| `last_verified_at` | `timestamptz` |  Nullable |
| `last_verification_ok` | `bool` |  |
| `last_heartbeat_sent_at` | `timestamptz` |  Nullable |
| `last_heartbeat_ok` | `bool` |  |
| `last_heartbeat_error` | `text` |  Nullable |
| `heartbeat_retry_count` | `int4` |  |
| `updated_at` | `timestamptz` |  |

## Table `customers`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `legal_name` | `text` |  |
| `trade_name` | `text` |  Nullable |
| `rfc` | `text` |  Nullable |
| `tax_regime` | `text` |  Nullable |
| `fiscal_address` | `text` |  Nullable |
| `fiscal_city` | `text` |  Nullable |
| `fiscal_state` | `text` |  Nullable |
| `fiscal_postal_code` | `text` |  Nullable |
| `contact_name` | `text` |  |
| `contact_role` | `text` |  Nullable |
| `contact_email` | `text` |  |
| `contact_phone_e164` | `text` |  Nullable |
| `business_sector` | `text` |  Nullable |
| `notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `deployments`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `customer_id` | `uuid` |  |
| `slug` | `text` |  Unique |
| `status` | `text` |  |
| `plan_key` | `text` |  |
| `setup_fee_mxn` | `numeric` |  Nullable |
| `retainer_mxn` | `numeric` |  Nullable |
| `currency` | `text` |  |
| `billing_period` | `text` |  |
| `install_url` | `text` |  Nullable |
| `install_region` | `text` |  Nullable |
| `contracted_at` | `timestamptz` |  Nullable |
| `activated_at` | `timestamptz` |  Nullable |
| `renews_at` | `timestamptz` |  Nullable |
| `suspended_at` | `timestamptz` |  Nullable |
| `cancelled_at` | `timestamptz` |  Nullable |
| `cancellation_reason` | `text` |  Nullable |
| `status_token` | `text` |  Unique |
| `internal_notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `contracts`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `deployment_id` | `uuid` |  |
| `template_version` | `text` |  |
| `document_hash` | `text` |  |
| `pdf_storage_path` | `text` |  Nullable |
| `signer_name` | `text` |  |
| `signer_role` | `text` |  Nullable |
| `signer_email` | `text` |  |
| `signer_phone_e164` | `text` |  Nullable |
| `verification_method` | `text` |  Nullable |
| `verified_at` | `timestamptz` |  Nullable |
| `signed_at` | `timestamptz` |  Nullable |
| `signer_ip` | `text` |  Nullable |
| `signer_user_agent` | `text` |  Nullable |
| `signer_geo` | `jsonb` |  Nullable |
| `timestamp_authority` | `text` |  Nullable |
| `timestamp_token` | `text` |  Nullable |
| `evidence` | `jsonb` |  |
| `voided_at` | `timestamptz` |  Nullable |
| `void_reason` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `licenses`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `deployment_id` | `uuid` |  |
| `token` | `text` |  |
| `key_version` | `text` |  |
| `fingerprint` | `text` |  Nullable |
| `issued_at` | `timestamptz` |  |
| `expires_at` | `timestamptz` |  |
| `revoked_at` | `timestamptz` |  Nullable |
| `revocation_reason` | `text` |  Nullable |
| `warn_after_days` | `int4` |  |
| `limit_features_after_days` | `int4` |  |
| `lock_dashboard_after_days` | `int4` |  |
| `last_heartbeat_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `license_heartbeats`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `license_id` | `uuid` |  |
| `deployment_id` | `uuid` |  |
| `received_at` | `timestamptz` |  |
| `installed_version` | `text` |  Nullable |
| `source_ip` | `text` |  Nullable |
| `health` | `jsonb` |  |
| `metrics` | `jsonb` |  |

## Table `provisioning_tasks`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `deployment_id` | `uuid` |  |
| `task_key` | `text` |  |
| `label` | `text` |  |
| `description` | `text` |  Nullable |
| `owner` | `text` |  |
| `status` | `text` |  |
| `is_blocking` | `bool` |  |
| `sort_order` | `int4` |  |
| `blocked_reason` | `text` |  Nullable |
| `completed_at` | `timestamptz` |  Nullable |
| `notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `provisioning_task_templates`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `task_key` | `text` | Primary |
| `label` | `text` |  |
| `description` | `text` |  Nullable |
| `owner` | `text` |  |
| `is_blocking` | `bool` |  |
| `applies_when` | `text` |  Nullable |
| `sort_order` | `int4` |  |

## Table `deployment_events`

Append-only (sin `UPDATE`/`DELETE`), salvo la cascada del borrado del despliegue y el `SET NULL` de `actor_user_id` al borrar un usuario (migración 80).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `deployment_id` | `uuid` |  |
| `event_type` | `text` |  |
| `description` | `text` |  Nullable |
| `previous_value` | `text` |  Nullable |
| `new_value` | `text` |  Nullable |
| `actor_user_id` | `uuid` |  Nullable |
| `metadata` | `jsonb` |  |
| `created_at` | `timestamptz` |  |

## Table `contract_otp_codes`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `contract_id` | `uuid` |  |
| `code_hash` | `text` |  |
| `channel` | `text` |  |
| `sent_to` | `text` |  |
| `expires_at` | `timestamptz` |  |
| `consumed_at` | `timestamptz` |  Nullable |
| `attempts` | `int4` |  |
| `created_at` | `timestamptz` |  |

## Table `telegram_connections`

Configuración del Bot de Telegram de cada organización (1:1). Los secretos (telegram_bot_token, telegram_webhook_secret) viven en Supabase Vault.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  Unique |
| `telegram_bot_id` | `int8` |  Unique |
| `bot_username` | `text` |  |
| `bot_first_name` | `text` |  Nullable |
| `webhook_token` | `text` |  Unique |
| `webhook_registered_at` | `timestamptz` |  Nullable |
| `status` | `text` |  |
| `last_error` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `telegram_identities`

Identidades de Telegram vinculadas a miembros de la organización. Autorización basada exclusivamente en telegram_user_id numérico inmutable.

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `organization_member_id` | `uuid` |  |
| `user_id` | `uuid` |  |
| `telegram_user_id` | `int8` |  Unique |
| `telegram_chat_id` | `int8` |  |
| `telegram_username` | `text` |  Nullable |
| `telegram_first_name` | `text` |  Nullable |
| `status` | `text` |  |
| `linked_at` | `timestamptz` |  |
| `revoked_at` | `timestamptz` |  Nullable |
| `last_seen_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `telegram_link_tokens`

Tokens efímeros de un solo uso para vincular una cuenta de Telegram vía deep link (/start <token>). Persiste únicamente SHA-256 (token_hash).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `organization_member_id` | `uuid` |  |
| `created_by_user_id` | `uuid` |  |
| `token_hash` | `text` |  Unique |
| `expires_at` | `timestamptz` |  |
| `used_at` | `timestamptz` |  Nullable |
| `used_by_telegram_user_id` | `int8` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `telegram_conversations`

Contexto conversacional de corto plazo por chat privado de Telegram (máx. 3 turnos con resultDigest <= 500 chars, TTL 30 min).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `telegram_chat_id` | `int8` |  |
| `telegram_identity_id` | `uuid` |  Nullable |
| `context` | `jsonb` |  |
| `context_expires_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `telegram_messages`

Bitácora de auditoría operativa del canal Telegram (metadatos de ejecución e intención sin almacenar el texto crudo ni datos sensibles).

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `conversation_id` | `uuid` |  Nullable |
| `telegram_identity_id` | `uuid` |  Nullable |
| `direction` | `text` |  |
| `telegram_update_id` | `int8` |  Nullable |
| `telegram_message_id` | `int8` |  Nullable |
| `intent` | `text` |  Nullable |
| `harness_status` | `text` |  Nullable |
| `execution_time_ms` | `int4` |  Nullable |
| `error` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `quotation_settings`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `organization_id` | `uuid` | Primary |
| `folio_prefix` | `text` |  |
| `validity_days` | `int4` |  |
| `cart_ttl_hours` | `int4` |  |
| `max_items` | `int4` |  |
| `terms_text` | `text` |  Nullable |
| `notes_default` | `text` |  Nullable |
| `email_sender` | `text` |  |
| `email_account_id` | `uuid` |  Nullable |
| `whatsapp_template_name` | `text` |  Nullable |
| `updated_at` | `timestamptz` |  |
| `updated_by` | `uuid` |  Nullable |

## Table `quotation_folio_counters`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `organization_id` | `uuid` | Primary |
| `year` | `int4` | Primary |
| `last_value` | `int8` |  |
| `updated_at` | `timestamptz` |  |

## Table `quotations`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `status` | `text` |  |
| `origin` | `text` |  |
| `contact_id` | `uuid` |  Nullable (NOT NULL si `status = 'borrador'`) |
| `first_conversation_id` | `text` |  Nullable |
| `last_conversation_id` | `text` |  Nullable |
| `last_channel` | `text` |  Nullable |
| `customer_name` | `text` |  Nullable |
| `customer_email` | `text` |  Nullable |
| `customer_phone_e164` | `text` |  Nullable |
| `customer_business_name` | `text` |  Nullable |
| `folio` | `text` |  Nullable, Unique (`organization_id`, `folio`) |
| `folio_year` | `int4` |  Nullable |
| `folio_number` | `int8` |  Nullable |
| `revision_of_id` | `uuid` |  Nullable |
| `revision_number` | `int4` |  |
| `currency` | `text` |  |
| `subtotal` | `numeric` |  |
| `tax_total` | `numeric` |  |
| `discount_total` | `numeric` |  |
| `total` | `numeric` |  |
| `totals_by_billing` | `jsonb` |  |
| `tax_breakdown` | `jsonb` |  |
| `notes` | `text` |  Nullable |
| `terms_text` | `text` |  Nullable |
| `issued_at` | `timestamptz` |  Nullable |
| `valid_until` | `date` |  Nullable |
| `pdf_storage_path` | `text` |  Nullable |
| `pdf_sha256` | `text` |  Nullable |
| `pdf_generated_at` | `timestamptz` |  Nullable |
| `last_activity_at` | `timestamptz` |  |
| `accepted_at` | `timestamptz` |  Nullable |
| `rejected_at` | `timestamptz` |  Nullable |
| `cancelled_at` | `timestamptz` |  Nullable |
| `status_reason` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |
| `created_by` | `uuid` |  Nullable |

Índice único parcial `ux_quotations_open_cart_per_contact (organization_id, contact_id) WHERE status = 'borrador'`: un solo carrito abierto por contacto.

## Table `quotation_items`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `quotation_id` | `uuid` |  |
| `organization_id` | `uuid` |  |
| `line_number` | `int4` |  Unique (`quotation_id`, `line_number`) |
| `variant_id` | `uuid` |  Unique (`quotation_id`, `variant_id`); sin FK deliberadamente |
| `product_id` | `uuid` |  Sin FK |
| `catalog_id` | `uuid` |  Sin FK |
| `sku` | `text` |  |
| `external_id` | `text` |  Nullable |
| `sat_product_key` | `text` |  Nullable |
| `sat_unit_key` | `text` |  Nullable |
| `item_type` | `text` |  |
| `billing_period` | `text` |  |
| `product_name` | `text` |  |
| `presentation` | `text` |  Nullable |
| `description` | `text` |  Nullable |
| `quantity` | `numeric` |  |
| `unit_price` | `numeric` |  |
| `price_includes_tax` | `bool` |  |
| `tax_rate` | `numeric` |  |
| `discount_amount` | `numeric` |  |
| `line_subtotal` | `numeric` |  |
| `line_tax` | `numeric` |  |
| `line_total` | `numeric` |  |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

## Table `quotation_deliveries`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `quotation_id` | `uuid` |  |
| `channel` | `text` |  |
| `recipient` | `text` |  Nullable |
| `status` | `text` |  |
| `skip_reason` | `text` |  Nullable |
| `error` | `text` |  Nullable |
| `provider_message_id` | `text` |  Nullable |
| `idempotency_key` | `text` |  Unique (`organization_id`, `idempotency_key`) |
| `attempts` | `int4` |  |
| `sent_at` | `timestamptz` |  Nullable |
| `created_at` | `timestamptz` |  |

## Table `quotation_events`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `organization_id` | `uuid` |  |
| `quotation_id` | `uuid` |  |
| `event_type` | `text` |  |
| `actor_user_id` | `uuid` |  Nullable |
| `conversation_id` | `text` |  Nullable |
| `payload` | `jsonb` |  |
| `created_at` | `timestamptz` |  |

Append-only (sin `UPDATE`/`DELETE`), salvo la cascada de `purge_abandoned_quotations()` y el `SET NULL` de `actor_user_id` al borrar un usuario (migración 79).

## Functions (cotizaciones y catálogo, migraciones 76–77)

| Función | Propósito |
|---------|-----------|
| `organization_has_catalog_feature(p_org_id)` | `product_rag` o `quotations` habilitada; guarda de escritura RLS del catálogo (H19). |
| `resolve_variant_for_org(...)` | Resolución determinista (organización dueña primero) y devuelve `item_type`, `is_inventoriable`, `billing_period`. |
| `sync_plan_to_catalog(p_plan_key)` | Proyecta `plans` al catálogo `managed_source = 'datagol_plans'`; disparada por trigger en `plans`. |
| `guard_managed_catalog_rows()` | Trigger: rechaza ediciones de campos administrados fuera de `datagol.managed_sync = 'on'`. |
| `enforce_variant_item_type()` | Trigger: no inventariables → `stock_status = 'no_aplica'`. |
| `quotation_cart_apply(...)` | Carrito por contacto: `set` / `remove` / `view`. |
| `quotation_emit(...)` | Emisión con folio sin huecos, re-resolución de precios y snapshots. |
| `quotation_search_products(...)` | Búsqueda léxica `pg_trgm` restringida a `catalog_access`. |
| `quotation_transition_allowed(from, to)` | Máquina de estados. |
| `purge_abandoned_quotations()` | Purga diaria (`pg_cron`) solo de `abandonada` vencidas por `retention_days`. |
| `admin_delete_organizations_cascade(ids)` | (Migración 78) Borra con `replica` solo filas append-only (`usage_events`, `contact_notes`, `feature_audit_log`) y luego un `DELETE` normal con cascada completa. Ejecutable solo por `service_role`. |

## RLS Policies

### `organization_members`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `members_self_access` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `platform_admins`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admins_self_select` | SELECT | authenticated | PERMISSIVE | `(user_id = auth.uid())` | — |

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
| `call_logs_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_conversations'::text)` | — |

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
| `appointments_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `appointments_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_pipeline'::text)` | `has_permission(organization_id, 'manage_pipeline'::text)` |

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
| `org_read` | SELECT | authenticated | PERMISSIVE | `((id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |
| `org_update` | UPDATE | authenticated | PERMISSIVE | `(has_permission(id, 'configure_agent'::text) OR is_platform_admin())` | `(has_permission(id, 'configure_agent'::text) OR is_platform_admin())` |

### `contact_notes`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `notes_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `notes_write` | INSERT | authenticated | PERMISSIVE | — | `has_permission(organization_id, 'edit_contacts'::text)` |

### `contact_addresses`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `addresses_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `addresses_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'edit_contacts'::text)` | `has_permission(organization_id, 'edit_contacts'::text)` |

### `whatsapp_messages`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `organization_attachments`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `thank_you_sends`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `contact_pipeline_transitions`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `leads`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `leads_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `leads_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_pipeline'::text)` | `has_permission(organization_id, 'manage_pipeline'::text)` |

### `weekly_reports`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `competitor_sites`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_isolation` | ALL | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` |

### `competitor_site_snapshots`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `tenant_read` | SELECT | public | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `contacts`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `contacts_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `contacts_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'edit_contacts'::text)` | `has_permission(organization_id, 'edit_contacts'::text)` |

### `unanswered_questions`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `unanswered_questions_admin_all` | ALL | authenticated | PERMISSIVE | `(EXISTS ( SELECT 1    FROM organization_members   WHERE ((organization_members.user_id = auth.uid()) AND (organization_members.role = 'platform_admin'::text))))` | — |
| `unanswered_questions_org_access` | ALL | authenticated | PERMISSIVE | `(organization_id IN ( SELECT om.organization_id    FROM organization_members om   WHERE (om.user_id = auth.uid())))` | `(organization_id IN ( SELECT om.organization_id    FROM organization_members om   WHERE (om.user_id = auth.uid())))` |

### `permissions`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `role_permissions`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `organization_role_permissions`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `org_role_perms_read` | SELECT | authenticated | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |
| `org_role_perms_write` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `permission_audit_log`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `perm_audit_read` | SELECT | authenticated | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `organization_invitations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `invitations_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_users'::text)` | — |

### `credential_groups`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `cred_groups_read` | SELECT | authenticated | PERMISSIVE | `((id IN ( SELECT organizations.credential_group_id    FROM organizations   WHERE (organizations.id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)))) OR is_platform_admin())` | — |

### `elevenlabs_plans`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `plans_read` | SELECT | authenticated | PERMISSIVE | `true` | — |

### `organization_variant_overrides`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `overrides_all` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_catalog'::text)` | `has_permission(organization_id, 'manage_catalog'::text)` |

### `product_kb_sync`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `kb_sync_read` | SELECT | authenticated | PERMISSIVE | `(product_id IN ( SELECT p.id    FROM products p   WHERE (p.catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))))` | — |

### `organization_concurrency_quota`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quota_read` | SELECT | authenticated | PERMISSIVE | `(organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids))` | — |

### `catalog_access`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_access_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |

### `variant_price_history`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `price_history_read` | SELECT | authenticated | PERMISSIVE | `(variant_id IN ( SELECT v.id    FROM product_variants v   WHERE (v.catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))))` | — |

### `catalog_imports`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `imports_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |

### `catalogs`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalogs_read` | SELECT | authenticated | PERMISSIVE | `(id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `catalogs_write` | ALL | authenticated | PERMISSIVE | `has_permission(owner_organization_id, 'manage_catalog'::text)` | `has_permission(owner_organization_id, 'manage_catalog'::text)` |

### `product_variants`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `product_variants_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `product_variants_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` |

### `catalog_import_mappings`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `import_mappings_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |

### `products`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `products_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `products_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` |

### `appointment_waitlist`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `appointment_waitlist_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_waitlist'::text)` | — |
| `appointment_waitlist_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_waitlist'::text)` | `has_permission(organization_id, 'manage_waitlist'::text)` |

### `catalog_custom_fields`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_custom_fields_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `catalog_custom_fields_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text) AND organization_has_catalog_feature(ca.organization_id))))` |

### `license_client_state`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `service_role_only` | ALL | service_role | PERMISSIVE | `true` | `true` |

### `provisioning_task_templates`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `provisioning_tasks`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `deployment_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `license_heartbeats`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `licenses`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `contract_otp_codes`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `contracts`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `deployments`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `customers`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `platform_admin_only` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |

### `usage_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `usage_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_costs'::text)` | — |

### `telegram_connections`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `telegram_connections_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | — |
| `telegram_connections_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | `has_permission(organization_id, 'manage_credentials'::text)` |

### `telegram_identities`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `telegram_identities_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | — |
| `telegram_identities_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | `has_permission(organization_id, 'manage_credentials'::text)` |

### `telegram_link_tokens`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `telegram_link_tokens_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | — |
| `telegram_link_tokens_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_credentials'::text)` | `has_permission(organization_id, 'manage_credentials'::text)` |

### `telegram_conversations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `telegram_conversations_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'use_nl_reports'::text)` | — |

### `telegram_messages`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `telegram_messages_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'use_nl_reports'::text)` | — |

### `quotation_settings`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotation_settings_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |

### `quotation_folio_counters`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotation_folio_counters_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |

### `quotations`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotations_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |

### `quotation_items`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotation_items_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |

### `quotation_deliveries`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotation_deliveries_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |

### `quotation_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `quotation_events_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_quotations'::text)` | — |
