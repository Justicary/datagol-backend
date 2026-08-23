-- =============================================================================
-- Datagol — Migración 62: imagen de producto en resolve_variant_for_org
-- =============================================================================
-- FASE D (docs/tasks/catalogo-productos-grupos-cred.md) — el tool de
-- voz/texto (src/routes/tools/products.ts) necesita `image_path` para
-- devolver `imageUrl` en el resultado. El agente de voz no puede usarla
-- (canal de audio); los canales de texto (WhatsApp) sí — el backend la
-- incluye siempre en el resultado (inofensiva en voz) y es la capa de texto
-- la que decide mostrarla, no una bifurcación de este RPC.
--
-- `create or replace function`: no se modifica la migración 56 ya aplicada,
-- se reemplaza la función en una migración nueva (CLAUDE.md).
-- =============================================================================

create or replace function resolve_variant_for_org(p_org_id uuid, p_sku text)
returns table (
  sku                text,
  product_name       text,
  presentation       text,
  price              numeric,
  currency           text,
  price_includes_tax boolean,
  stock_status       text,
  stock_note         text,
  is_available       boolean,
  image_path         text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select
    v.sku,
    p.name,
    v.presentation,
    coalesce(ov.price, v.price),
    v.currency,
    v.price_includes_tax,
    coalesce(ov.stock_status, v.stock_status),
    coalesce(ov.stock_note, v.stock_note),
    coalesce(ov.is_available, true) and v.is_active and p.is_active,
    p.image_path
  from product_variants v
  join products p on p.id = v.product_id
  join catalog_access ca
    on ca.catalog_id = v.catalog_id and ca.organization_id = p_org_id
  left join organization_variant_overrides ov
    on ov.variant_id = v.id and ov.organization_id = p_org_id
  where upper(v.sku) = upper(p_sku)
  limit 1;
$$;
