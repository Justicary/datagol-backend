-- =============================================================================
-- Datagol — Migración: Catálogo de productos y grupos de credenciales
-- =============================================================================
-- Dos capacidades entrelazadas:
--
--   1. GRUPOS DE CREDENCIALES. Varias organizaciones de una misma instalación
--      (sucursales de una franquicia) comparten un workspace de ElevenLabs:
--      mismas llaves, mismo pozo de concurrencia, una sola knowledge base.
--
--   2. CATÁLOGO DE PRODUCTOS. La capa descriptiva vive en la KB de ElevenLabs
--      (búsqueda semántica, sin costo extra). La capa transaccional —precio y
--      disponibilidad— vive aquí y se consulta por SKU.
--
-- REGLA INVIOLABLE: el precio NUNCA va a la knowledge base. La KB es un índice
-- precalculado; un precio ahí es un precio congelado, y un agente cotizando mal
-- compromete al negocio del cliente frente a un consumidor.
--
-- Las existencias son INFORMATIVAS. El agente nunca afirma disponibilidad como
-- un hecho: la matiza y ofrece confirmarla.
-- =============================================================================


-- =============================================================================
-- BLOQUE 1 — Planes de ElevenLabs y concurrencia
-- =============================================================================
-- Los límites de concurrencia cambian con la oferta del proveedor. En tabla,
-- no en código.

create table if not exists elevenlabs_plans (
  key                         text primary key,
  name                        text not null,
  max_concurrent              int not null check (max_concurrent > 0),
  monthly_credits_amount      int not null check (max_concurrent > 0),
  minutes_per_month           int not null check (max_concurrent > 0),
  notes                       text,
  updated_at                  timestamptz not null default now()
);

insert into elevenlabs_plans (key, name, max_concurrent, monthly_credits_amount, minutes_per_month, notes) values
  ('creator',  'Creator',   20, 161000, 365,  'Acumulado: 4 free + 6 starter + 10 creator'),
  ('pro',      'Pro',       40, 761000, 1603,  'Acumulado: 20 creator + 20 pro'),
  ('scale',    'Scale',     70, 2561000, 5341,  'Acumulado: 40 pro + 30 Scale'),
  ('business', 'Business', 110, 8561000, 17716,  'Acumulado: 70 Scale + 40 Business')
on conflict (key) do update
  set max_concurrent = excluded.max_concurrent,
      notes          = excluded.notes,
      updated_at     = now();


-- =============================================================================
-- BLOQUE 2 — Grupos de credenciales
-- =============================================================================
-- Un grupo es un workspace de proveedor. En el caso normal contiene una sola
-- organización; en una franquicia, varias.

create table if not exists credential_groups (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,

  -- Organización que administra las llaves compartidas. Solo su owner puede
  -- rotarlas: rotar una llave compartida tumba a todo el grupo.
  owner_organization_id  uuid,

  elevenlabs_plan_key    text references elevenlabs_plans(key),

  -- Permite fijar un pozo distinto al del plan (acuerdo enterprise, etc.).
  concurrency_override   int check (concurrency_override is null or concurrency_override > 0),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists trg_cred_groups_updated on credential_groups;
create trigger trg_cred_groups_updated before update on credential_groups
  for each row execute function set_updated_at();

-- Toda organización pertenece a un grupo. En instalaciones de un solo
-- inquilino, es un grupo de uno y nadie lo nota.
alter table organizations
  add column if not exists credential_group_id uuid references credential_groups(id);

-- Backfill: un grupo por organización existente.
do $$
declare r record; v_group uuid;
begin
  for r in select id, name from organizations where credential_group_id is null loop
    insert into credential_groups (name, owner_organization_id)
    values (r.name, r.id)
    returning id into v_group;

    update organizations set credential_group_id = v_group where id = r.id;
  end loop;
end $$;

alter table organizations alter column credential_group_id set not null;

alter table credential_groups
  add constraint credential_groups_owner_fk
  foreign key (owner_organization_id) references organizations(id) on delete set null;

create index if not exists idx_orgs_credential_group
  on organizations (credential_group_id);

-- Pozo efectivo de concurrencia del grupo.
create or replace function credential_group_concurrency(p_group_id uuid)
returns int
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    g.concurrency_override,
    p.max_concurrent,
    5
  )
  from credential_groups g
  left join elevenlabs_plans p on p.key = g.elevenlabs_plan_key
  where g.id = p_group_id;
$$;


-- =============================================================================
-- BLOQUE 3 — Resolución del agente a la organización
-- =============================================================================
-- Con workspace compartido el webhook llega con un solo secreto de firma para
-- todo el grupo. La resolución es en dos pasos:
--   1. Verificar la firma con el secreto del grupo  → autentica el origen
--   2. Resolver la organización por agent_id        → ya autenticado
-- El webhook_token identifica al GRUPO, no a la organización.

create unique index if not exists ux_orgs_elevenlabs_agent
  on organizations (elevenlabs_agent_id)
  where elevenlabs_agent_id is not null;

comment on column organizations.elevenlabs_agent_id is
  'Único en la instalación. Es la llave que resuelve la organización desde el payload del webhook cuando el workspace es compartido.';

-- Cuotas blandas de concurrencia. No rechazan llamadas: dan visibilidad de
-- quién está consumiendo el pozo común y quién puede estar causando burst.
create table if not exists organization_concurrency_quota (
  organization_id  uuid primary key references organizations(id) on delete cascade,
  soft_limit       int not null check (soft_limit > 0),
  notes            text,
  updated_at       timestamptz not null default now()
);

comment on table organization_concurrency_quota is
  'Reparto informativo del pozo del grupo. Al rebasarse se avisa; nunca se rechaza una llamada.';


-- =============================================================================
-- BLOQUE 4 — Catálogos
-- =============================================================================
-- El catálogo es la entidad de propiedad. NO se usa organization_id NULL para
-- representar "global": con NULL, el predicado de RLS deja de filtrar y se abre
-- escritura cross-tenant.

create table if not exists catalogs (
  id                     uuid primary key default gen_random_uuid(),
  owner_organization_id  uuid not null references organizations(id) on delete cascade,
  name                   text not null,
  description            text,
  is_shared              boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists trg_catalogs_updated on catalogs;
create trigger trg_catalogs_updated before update on catalogs
  for each row execute function set_updated_at();

-- Acceso explícito. El dueño se agrega solo, con edición.
create table if not exists catalog_access (
  catalog_id       uuid not null references catalogs(id) on delete cascade,
  organization_id  uuid not null references organizations(id) on delete cascade,
  can_edit         boolean not null default false,
  granted_at       timestamptz not null default now(),
  primary key (catalog_id, organization_id)
);

create index if not exists idx_catalog_access_org
  on catalog_access (organization_id);

create or replace function grant_owner_catalog_access()
returns trigger language plpgsql as $$
begin
  insert into catalog_access (catalog_id, organization_id, can_edit)
  values (new.id, new.owner_organization_id, true)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_catalog_owner_access on catalogs;
create trigger trg_catalog_owner_access after insert on catalogs
  for each row execute function grant_owner_catalog_access();

-- Compartir solo se permite dentro del mismo grupo de credenciales.
create or replace function enforce_catalog_share_scope()
returns trigger language plpgsql
security definer set search_path = public, pg_temp
as $$
declare v_owner_group uuid; v_target_group uuid;
begin
  select o.credential_group_id into v_owner_group
  from catalogs c join organizations o on o.id = c.owner_organization_id
  where c.id = new.catalog_id;

  select credential_group_id into v_target_group
  from organizations where id = new.organization_id;

  if v_owner_group is distinct from v_target_group then
    raise exception 'Un catálogo solo puede compartirse dentro del mismo grupo de credenciales.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_catalog_share_scope on catalog_access;
create trigger trg_catalog_share_scope
  before insert or update on catalog_access
  for each row execute function enforce_catalog_share_scope();

-- Catálogos visibles para el usuario autenticado.
create or replace function auth_catalog_ids()
returns setof uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select ca.catalog_id
  from catalog_access ca
  where ca.organization_id in (select auth_active_organization_ids());
$$;


-- =============================================================================
-- BLOQUE 5 — Productos (capa descriptiva → knowledge base)
-- =============================================================================

create table if not exists products (
  id                  uuid primary key default gen_random_uuid(),
  catalog_id          uuid not null references catalogs(id) on delete cascade,

  name                text not null,
  brand               text,
  category            text,
  description         text,

  -- Campos que alimentan la búsqueda semántica.
  active_components   text,
  suggested_use       text,
  contraindications   text,
  keywords            text,

  -- Clave de producto/servicio del SAT. Requisito para CFDI si algún día se
  -- factura desde el sistema. Cuesta nada guardarla ahora.
  sat_product_key     text,

  is_active           boolean not null default true,
  external_id         text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (id, catalog_id)          -- habilita la FK compuesta de variantes
);

create index if not exists idx_products_catalog
  on products (catalog_id) where is_active;
create index if not exists idx_products_category
  on products (catalog_id, category) where is_active;

drop trigger if exists trg_products_updated on products;
create trigger trg_products_updated before update on products
  for each row execute function set_updated_at();


-- =============================================================================
-- BLOQUE 6 — Variantes (capa transaccional → consulta por SKU)
-- =============================================================================
-- El SKU vive aquí, no en el producto: una farmacia vende el mismo gel en
-- 60 ml y 120 ml a precios distintos.

create table if not exists product_variants (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null,
  catalog_id          uuid not null,

  sku                 text not null,
  presentation        text,
  barcode             text,

  price               numeric(12,2) check (price is null or price >= 0),
  currency            text not null default 'MXN' check (currency in ('MXN','USD')),

  -- En México el precio al consumidor normalmente incluye IVA, pero el
  -- catálogo del cliente puede venir sin él. Sin este dato el agente cotiza
  -- mal exactamente el 16% de las veces.
  price_includes_tax  boolean not null default true,
  tax_rate            numeric(5,4) not null default 0.1600,

  -- INFORMATIVA. No es inventario en tiempo real: el agente debe matizarla.
  stock_status        text not null default 'sin_dato'
                      check (stock_status in ('disponible','bajo','agotado','bajo_pedido','sin_dato')),
  stock_note          text,

  is_active           boolean not null default true,
  price_changed_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  foreign key (product_id, catalog_id) references products(id, catalog_id) on delete cascade,
  unique (catalog_id, sku)
);

create index if not exists idx_variants_product
  on product_variants (product_id) where is_active;
create unique index if not exists ux_variants_sku_lookup
  on product_variants (catalog_id, upper(sku));

drop trigger if exists trg_variants_updated on product_variants;
create trigger trg_variants_updated before update on product_variants
  for each row execute function set_updated_at();

comment on column product_variants.stock_status is
  'Informativa, no inventario en vivo. El prompt del agente debe matizarla: "creo que hay disponible, permítame confirmarlo".';

-- Historial de precio. Cuando un cliente reclame "su robot me dijo otro
-- precio", hay que poder saber cuál estaba vigente ese día.
create table if not exists variant_price_history (
  id            uuid primary key default gen_random_uuid(),
  variant_id    uuid not null references product_variants(id) on delete cascade,
  price         numeric(12,2),
  currency      text,
  changed_at    timestamptz not null default now(),
  changed_by    uuid references auth.users(id),
  source        text
);

create index if not exists idx_price_history_variant
  on variant_price_history (variant_id, changed_at desc);

create or replace function record_price_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.price is not distinct from old.price then
    return new;
  end if;

  new.price_changed_at := now();

  insert into variant_price_history (variant_id, price, currency, source)
  values (new.id, new.price, new.currency, tg_op);

  return new;
end;
$$;

drop trigger if exists trg_variant_price_history on product_variants;
create trigger trg_variant_price_history
  before insert or update of price on product_variants
  for each row execute function record_price_change();


-- =============================================================================
-- BLOQUE 7 — Precio por sucursal
-- =============================================================================
-- Sin override aplica el precio del catálogo. La mayoría de los clientes nunca
-- crea uno y ni se entera de que existe.

create table if not exists organization_variant_overrides (
  organization_id   uuid not null references organizations(id) on delete cascade,
  variant_id        uuid not null references product_variants(id) on delete cascade,
  price             numeric(12,2) check (price is null or price >= 0),
  stock_status      text check (stock_status is null or stock_status in
                      ('disponible','bajo','agotado','bajo_pedido','sin_dato')),
  stock_note        text,
  is_available      boolean not null default true,
  updated_at        timestamptz not null default now(),
  primary key (organization_id, variant_id)
);

drop trigger if exists trg_overrides_updated on organization_variant_overrides;
create trigger trg_overrides_updated before update on organization_variant_overrides
  for each row execute function set_updated_at();

-- Resolución que consume el tool del agente: SKU → precio y disponibilidad
-- vigentes para ESA organización.
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
  is_available       boolean
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
    coalesce(ov.is_available, true) and v.is_active and p.is_active
  from product_variants v
  join products p on p.id = v.product_id
  join catalog_access ca
    on ca.catalog_id = v.catalog_id and ca.organization_id = p_org_id
  left join organization_variant_overrides ov
    on ov.variant_id = v.id and ov.organization_id = p_org_id
  where upper(v.sku) = upper(p_sku)
  limit 1;
$$;


-- =============================================================================
-- BLOQUE 8 — Sincronización con la knowledge base
-- =============================================================================
-- El destino de sincronización es el WORKSPACE, es decir el grupo de
-- credenciales. Con workspace compartido, un solo documento sirve a todas las
-- sucursales.

create table if not exists product_kb_sync (
  product_id           uuid not null references products(id) on delete cascade,
  credential_group_id  uuid not null references credential_groups(id) on delete cascade,

  kb_document_id       text,
  synced_content_hash  text,
  synced_at            timestamptz,
  rag_indexed_at       timestamptz,

  status               text not null default 'pendiente'
                       check (status in ('pendiente','sincronizado','error','eliminado')),
  error                text,
  attempts             int not null default 0,
  updated_at           timestamptz not null default now(),

  primary key (product_id, credential_group_id)
);

create index if not exists idx_kb_sync_pending
  on product_kb_sync (credential_group_id, updated_at)
  where status in ('pendiente','error');

drop trigger if exists trg_kb_sync_updated on product_kb_sync;
create trigger trg_kb_sync_updated before update on product_kb_sync
  for each row execute function set_updated_at();

-- Un cambio DESCRIPTIVO marca el producto para resincronizar.
-- Un cambio de PRECIO no: el precio no vive en la KB. Ese es el beneficio
-- central del diseño — las descripciones cambian pocas veces al año.
create or replace function mark_product_for_kb_sync()
returns trigger language plpgsql
security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.name              is not distinct from old.name
     and new.description       is not distinct from old.description
     and new.active_components is not distinct from old.active_components
     and new.suggested_use     is not distinct from old.suggested_use
     and new.contraindications is not distinct from old.contraindications
     and new.category          is not distinct from old.category
     and new.brand             is not distinct from old.brand
     and new.keywords          is not distinct from old.keywords
     and new.is_active         is not distinct from old.is_active then
    return new;
  end if;

  insert into product_kb_sync (product_id, credential_group_id, status)
  select new.id, o.credential_group_id, 'pendiente'
  from catalogs c
  join organizations o on o.id = c.owner_organization_id
  where c.id = new.catalog_id
  on conflict (product_id, credential_group_id)
  do update set status = 'pendiente', updated_at = now();

  return new;
end;
$$;

drop trigger if exists trg_product_kb_sync on products;
create trigger trg_product_kb_sync
  after insert or update on products
  for each row execute function mark_product_for_kb_sync();


-- =============================================================================
-- BLOQUE 9 — Importaciones
-- =============================================================================

create table if not exists catalog_imports (
  id             uuid primary key default gen_random_uuid(),
  catalog_id     uuid not null references catalogs(id) on delete cascade,
  file_name      text,
  mode           text not null default 'completo'
                 check (mode in ('completo','solo_precios')),
  status         text not null default 'procesando'
                 check (status in ('procesando','completado','fallido','revertido')),
  rows_total     int not null default 0,
  rows_created   int not null default 0,
  rows_updated   int not null default 0,
  rows_failed    int not null default 0,
  column_mapping jsonb not null default '{}'::jsonb,
  errors         jsonb not null default '[]'::jsonb,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

create index if not exists idx_imports_catalog
  on catalog_imports (catalog_id, created_at desc);


-- =============================================================================
-- BLOQUE 10 — Feature y permisos
-- =============================================================================

insert into features (key, name, description, category, has_cost_impact, sort_order)
values ('product_rag', 'Catálogo de productos',
        'Importar catálogo y que el agente sugiera productos con precio vigente',
        'operacion', false, 180)
on conflict (key) do nothing;

insert into plan_features (plan_key, feature_key) values
  ('elite','product_rag'), ('enterprise','product_rag')
on conflict do nothing;

insert into permissions (key, name, description, category, is_sensitive, sort_order) values
  ('view_catalog',   'Ver catálogo',      'Consultar productos y precios',       'datos',     false, 160),
  ('manage_catalog', 'Gestionar catálogo','Importar, editar productos y precios','operacion', false, 170)
on conflict (key) do nothing;

insert into role_permissions (role, permission_key) values
  ('viewer','view_catalog'),
  ('member','view_catalog'),
  ('admin','view_catalog'), ('admin','manage_catalog'),
  ('owner','view_catalog'),  ('owner','manage_catalog')
on conflict do nothing;


-- =============================================================================
-- BLOQUE 11 — RLS
-- =============================================================================

alter table credential_groups              enable row level security;
alter table elevenlabs_plans               enable row level security;
alter table organization_concurrency_quota enable row level security;
alter table catalogs                       enable row level security;
alter table catalog_access                 enable row level security;
alter table products                       enable row level security;
alter table product_variants               enable row level security;
alter table variant_price_history          enable row level security;
alter table organization_variant_overrides enable row level security;
alter table product_kb_sync                enable row level security;
alter table catalog_imports                enable row level security;

drop policy if exists plans_read on elevenlabs_plans;
create policy plans_read on elevenlabs_plans
  for select to authenticated using (true);

drop policy if exists cred_groups_read on credential_groups;
create policy cred_groups_read on credential_groups
  for select to authenticated
  using (id in (select credential_group_id from organizations
                where id in (select auth_active_organization_ids()))
         or is_platform_admin());

drop policy if exists quota_read on organization_concurrency_quota;
create policy quota_read on organization_concurrency_quota
  for select to authenticated
  using (organization_id in (select auth_active_organization_ids()));

drop policy if exists catalogs_read on catalogs;
create policy catalogs_read on catalogs
  for select to authenticated
  using (id in (select auth_catalog_ids()));

drop policy if exists catalogs_write on catalogs;
create policy catalogs_write on catalogs
  for all to authenticated
  using (has_permission(owner_organization_id, 'manage_catalog'))
  with check (has_permission(owner_organization_id, 'manage_catalog'));

drop policy if exists catalog_access_read on catalog_access;
create policy catalog_access_read on catalog_access
  for select to authenticated
  using (catalog_id in (select auth_catalog_ids()));

-- Productos y variantes: lectura por acceso al catálogo, escritura por
-- permiso de edición sobre él.
do $$
declare t text;
begin
  foreach t in array array['products','product_variants'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format($f$
      create policy %I_read on %I
        for select to authenticated
        using (catalog_id in (select auth_catalog_ids()))
    $f$, t, t);

    execute format('drop policy if exists %I_write on %I', t, t);
    execute format($f$
      create policy %I_write on %I
        for all to authenticated
        using (catalog_id in (
                 select ca.catalog_id from catalog_access ca
                 where ca.organization_id in (select auth_active_organization_ids())
                   and ca.can_edit
                   and has_permission(ca.organization_id, 'manage_catalog')))
        with check (catalog_id in (
                 select ca.catalog_id from catalog_access ca
                 where ca.organization_id in (select auth_active_organization_ids())
                   and ca.can_edit
                   and has_permission(ca.organization_id, 'manage_catalog')))
    $f$, t, t);
  end loop;
end $$;

drop policy if exists price_history_read on variant_price_history;
create policy price_history_read on variant_price_history
  for select to authenticated
  using (variant_id in (
    select v.id from product_variants v
    where v.catalog_id in (select auth_catalog_ids())));

drop policy if exists overrides_all on organization_variant_overrides;
create policy overrides_all on organization_variant_overrides
  for all to authenticated
  using (has_permission(organization_id, 'view_catalog'))
  with check (has_permission(organization_id, 'manage_catalog'));

drop policy if exists kb_sync_read on product_kb_sync;
create policy kb_sync_read on product_kb_sync
  for select to authenticated
  using (product_id in (
    select p.id from products p where p.catalog_id in (select auth_catalog_ids())));

drop policy if exists imports_read on catalog_imports;
create policy imports_read on catalog_imports
  for select to authenticated
  using (catalog_id in (select auth_catalog_ids()));


-- =============================================================================
-- BLOQUE 12 — Vistas
-- =============================================================================

-- Ocupación del pozo de concurrencia por grupo.
create or replace view v_concurrency_allocation
with (security_invoker = true) as
select
  g.id                                  as credential_group_id,
  g.name                                as grupo,
  g.elevenlabs_plan_key                 as plan,
  credential_group_concurrency(g.id)    as pozo_total,
  coalesce(sum(q.soft_limit), 0)::int   as cuotas_asignadas,
  credential_group_concurrency(g.id) - coalesce(sum(q.soft_limit), 0)::int as sin_asignar,
  count(o.id)                           as organizaciones
from credential_groups g
left join organizations o on o.credential_group_id = g.id
left join organization_concurrency_quota q on q.organization_id = o.id
group by g.id, g.name, g.elevenlabs_plan_key;

-- Estado de sincronización de la KB.
create or replace view v_kb_sync_status
with (security_invoker = true) as
select
  c.id as catalog_id, c.name as catalogo,
  s.credential_group_id,
  count(*)                                          as total,
  count(*) filter (where s.status = 'sincronizado') as sincronizados,
  count(*) filter (where s.status = 'pendiente')    as pendientes,
  count(*) filter (where s.status = 'error')        as con_error,
  max(s.synced_at)                                  as ultima_sincronizacion
from product_kb_sync s
join products p on p.id = s.product_id
join catalogs c on c.id = p.catalog_id
group by c.id, c.name, s.credential_group_id;


-- =============================================================================
-- BLOQUE 13 — SOLO PLANO DE CONTROL (api.datagol.net) | NO LA HE APLICADO AUN 23/08/26
-- =============================================================================
-- ⚠️ Ejecutar únicamente en el proyecto Supabase de api.datagol.net.
-- El superadmin decide en el onboarding cómo se comporta el catálogo.

alter table deployments
  add column if not exists catalog_mode text not null default 'por_organizacion'
    check (catalog_mode in ('por_organizacion','compartido','sin_catalogo')),
  add column if not exists expected_organizations int not null default 1
    check (expected_organizations > 0),
  add column if not exists elevenlabs_plan_key text,
  add column if not exists billing_model text not null default 'estandar'
    check (billing_model in ('estandar','enterprise'));

comment on column deployments.catalog_mode is
  'por_organizacion: cada organización con su catálogo. compartido: un catálogo para todas las organizaciones de la instalación (franquicia). Lo decide el superadmin en el onboarding.';

comment on column deployments.billing_model is
  'enterprise: la instalación se cotiza fuera de tarifa de lista (varias organizaciones, plan de proveedor superior).';

insert into provisioning_task_templates (task_key, label, description, owner, is_blocking, sort_order) values
  ('plan_proveedor_contratado', 'Plan de proveedor contratado',
   'Plan de ElevenLabs acorde a la concurrencia requerida por el grupo',
   'cliente', true, 65),
  ('catalogo_importado', 'Catálogo importado',
   'Productos cargados y sincronizados con la base de conocimiento del agente',
   'cliente', false, 105)
on conflict (task_key) do nothing;


-- =============================================================================
-- BLOQUE 14 — Verificación
-- =============================================================================

-- Toda organización debe tener grupo:
-- select count(*) from organizations where credential_group_id is null;

-- Reparto del pozo de concurrencia:
-- select * from v_concurrency_allocation;

-- Estado de sincronización:
-- select * from v_kb_sync_status;

-- Prueba de resolución por SKU:
-- select * from resolve_variant_for_org('<org_uuid>', 'ARN-GEL-060');

-- SKUs duplicados dentro de un catálogo (no debe devolver filas):
-- select catalog_id, upper(sku), count(*) from product_variants
-- group by 1,2 having count(*) > 1;