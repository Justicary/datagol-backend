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
| `custom_fields` | `jsonb` | Default: '{}'::jsonb |

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
| `custom_fields` | `jsonb` | Default: '{}'::jsonb |

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

## Table `catalog_custom_fields`

### Columns

| Name | Type | Constraints |
|------|------|-------------|
| `id` | `uuid` | Primary |
| `catalog_id` | `uuid` |  |
| `entity_type` | `text` |  |
| `name` | `text` |  |
| `key` | `text` |  |
| `field_type` | `text` |  |
| `options` | `jsonb` | Default: '[]'::jsonb |
| `description` | `text` |  Nullable |
| `is_required` | `bool` | Default: false |
| `include_in_rag` | `bool` | Default: true |
| `order_index` | `int4` | Default: 0 |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

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

## Table `appointment_waitlist`

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
| `party_size` | `int4` | Default: 2 |
| `preferred_date_start` | `date` |  |
| `preferred_date_end` | `date` |  |
| `preferred_time_start` | `time` |  Nullable |
| `preferred_time_end` | `time` |  Nullable |
| `status` | `text` | Default: 'pendiente' |
| `priority` | `text` | Default: 'normal' |
| `offered_appointment_id` | `uuid` |  Nullable |
| `offered_at` | `timestamptz` |  Nullable |
| `offer_expires_at` | `timestamptz` |  Nullable |
| `offer_token_hash` | `text` |  Nullable, Unique |
| `offer_viewed_at` | `timestamptz` |  Nullable |
| `offered_slot_start` | `timestamptz` |  Nullable |
| `offered_slot_end` | `timestamptz` |  Nullable |
| `notification_channel` | `text` | Default: 'whatsapp' |
| `notes` | `text` |  Nullable |
| `created_at` | `timestamptz` |  |
| `updated_at` | `timestamptz` |  |

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

### `organization_features`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `admin_write_features` | ALL | authenticated | PERMISSIVE | `is_platform_admin()` | `is_platform_admin()` |
| `tenant_read_features` | SELECT | public | PERMISSIVE | `((organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) OR is_platform_admin())` | — |

### `appointments`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `appointments_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_contacts'::text)` | — |
| `appointments_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_pipeline'::text)` | `has_permission(organization_id, 'manage_pipeline'::text)` |

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

### `usage_events`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `usage_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_costs'::text)` | — |

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

### `product_variants`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `product_variants_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `product_variants_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` |

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

### `products`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `products_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `products_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` |

### `catalog_custom_fields`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `catalog_custom_fields_read` | SELECT | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT auth_catalog_ids() AS auth_catalog_ids))` | — |
| `catalog_custom_fields_write` | ALL | authenticated | PERMISSIVE | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` | `(catalog_id IN ( SELECT ca.catalog_id    FROM catalog_access ca   WHERE ((ca.organization_id IN ( SELECT auth_active_organization_ids() AS auth_active_organization_ids)) AND ca.can_edit AND has_permission(ca.organization_id, 'manage_catalog'::text))))` |

### `appointment_waitlist`

| Policy | Command | Roles | Action | USING | WITH CHECK |
|--------|---------|-------|--------|-------|------------|
| `appointment_waitlist_read` | SELECT | authenticated | PERMISSIVE | `has_permission(organization_id, 'view_waitlist'::text)` | — |
| `appointment_waitlist_write` | ALL | authenticated | PERMISSIVE | `has_permission(organization_id, 'manage_waitlist'::text)` | `has_permission(organization_id, 'manage_waitlist'::text)` |


