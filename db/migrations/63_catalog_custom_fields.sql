-- =============================================================================
-- Datagol — Migración 63: campos personalizados en catálogo (productos y variantes)
-- =============================================================================
-- Permite a las organizaciones definir atributos y columnas adicionales en sus
-- catálogos (ej. "Puntos", "Sabor", "Laboratorio", "Material", "Talla",
-- "Requiere Receta") con validación por tipo (text, number, boolean, select)
-- tanto a nivel de producto general como a nivel de variante (SKU).
--
-- Los valores se persisten en columnas JSONB indexadas (GIN) en `products` y
-- `product_variants`. Las definiciones se gestionan en `catalog_custom_fields`
-- protegidas por RLS y verificadas por la API.
-- =============================================================================

-- 1. Columnas JSONB en products y product_variants
alter table products
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

create index if not exists idx_products_custom_fields
  on products using gin (custom_fields);

alter table product_variants
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

create index if not exists idx_variants_custom_fields
  on product_variants using gin (custom_fields);

-- 2. Tabla de definiciones de campos personalizados por catálogo
create table if not exists catalog_custom_fields (
  id             uuid primary key default gen_random_uuid(),
  catalog_id     uuid not null references catalogs(id) on delete cascade,
  entity_type    text not null check (entity_type in ('product', 'variant')),
  name           text not null,
  key            text not null,
  field_type     text not null check (field_type in ('text', 'number', 'boolean', 'select')),
  options        jsonb not null default '[]'::jsonb,
  description    text,
  is_required    boolean not null default false,
  include_in_rag boolean not null default true,
  order_index    integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (catalog_id, entity_type, key)
);

create index if not exists idx_catalog_custom_fields_lookup
  on catalog_custom_fields (catalog_id, entity_type, order_index);

drop trigger if exists trg_catalog_custom_fields_updated on catalog_custom_fields;
create trigger trg_catalog_custom_fields_updated
  before update on catalog_custom_fields
  for each row execute function set_updated_at();

-- 3. Row Level Security (RLS)
alter table catalog_custom_fields enable row level security;

drop policy if exists catalog_custom_fields_read on catalog_custom_fields;
create policy catalog_custom_fields_read on catalog_custom_fields
  for select to authenticated
  using (catalog_id in (select auth_catalog_ids()));

drop policy if exists catalog_custom_fields_write on catalog_custom_fields;
create policy catalog_custom_fields_write on catalog_custom_fields
  for all to authenticated
  using (
    catalog_id in (
      select ca.catalog_id
      from catalog_access ca
      where ca.organization_id in (select auth_active_organization_ids())
        and ca.can_edit
        and has_permission(ca.organization_id, 'manage_catalog')
    )
  )
  with check (
    catalog_id in (
      select ca.catalog_id
      from catalog_access ca
      where ca.organization_id in (select auth_active_organization_ids())
        and ca.can_edit
        and has_permission(ca.organization_id, 'manage_catalog')
    )
  );

comment on table catalog_custom_fields is
  'Definiciones de campos personalizados por catálogo para productos y variantes (src/routes/catalogs.ts). Soporta tipos text, number, boolean y select, con bandera include_in_rag para inyección automática en ElevenLabs.';
comment on column products.custom_fields is
  'Valores estructurados de campos personalizados a nivel de producto general (clave = key en catalog_custom_fields).';
comment on column product_variants.custom_fields is
  'Valores estructurados de campos personalizados a nivel de variante/SKU (clave = key en catalog_custom_fields).';
