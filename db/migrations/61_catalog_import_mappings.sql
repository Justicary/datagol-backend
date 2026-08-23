-- =============================================================================
-- Datagol — Migración 61: mapeos de columnas de importación guardados
-- =============================================================================
-- FASE E (docs/tasks/catalogo-productos-grupos-cred.md): "Mapeo de columnas
-- configurable. Cada cliente trae un formato distinto y nadie va a
-- reformatear su archivo." Un mismo cliente reimporta con el mismo formato
-- mes a mes — guardar el mapeo evita repetir el paso manual cada vez.
--
-- Mismo patrón de acceso que catalog_imports: lectura por RLS
-- (auth_catalog_ids()), escritura únicamente vía la API con supabaseAdmin
-- (routes/catalogs.ts), que ya verifica manage_catalog y pertenencia al
-- catálogo explícitamente (AGENTS.md §16/FASE F) — no hace falta una policy
-- de escritura porque ninguna consulta de escritura pasa por RLS.
-- =============================================================================

create table if not exists catalog_import_mappings (
  id             uuid primary key default gen_random_uuid(),
  catalog_id     uuid not null references catalogs(id) on delete cascade,
  name           text not null,
  mode           text not null
                 check (mode in ('completo','solo_precios')),
  column_mapping jsonb not null default '{}'::jsonb,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now()
);

create index if not exists idx_import_mappings_catalog
  on catalog_import_mappings (catalog_id, created_at desc);

alter table catalog_import_mappings enable row level security;

drop policy if exists import_mappings_read on catalog_import_mappings;
create policy import_mappings_read on catalog_import_mappings
  for select to authenticated
  using (catalog_id in (select auth_catalog_ids()));

comment on table catalog_import_mappings is
  'Mapeos de columnas de importación guardados y reutilizables (src/routes/catalogs.ts, GET/POST .../import-mappings). No participa en la aplicación del import — solo precarga columnMapping en el formulario.';
