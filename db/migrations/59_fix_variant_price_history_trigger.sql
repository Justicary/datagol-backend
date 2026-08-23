-- =============================================================================
-- Datagol — Migración 59: corrige trg_variant_price_history (INSERT roto)
-- =============================================================================
-- Bug estructural idéntico en naturaleza al que motivó la migración 57 con
-- credential_groups: `record_price_change()` (db/migrations/56_catalogo_productos.sql
-- BLOQUE 6) es un trigger BEFORE INSERT OR UPDATE OF price sobre
-- product_variants que, en el caso INSERT, intenta insertar una fila en
-- variant_price_history con variant_id = new.id — pero en un trigger BEFORE,
-- la fila de product_variants AÚN NO EXISTE físicamente en la tabla, así que
-- variant_price_history_variant_id_fkey se viola siempre. Confirmado con un
-- repro mínimo contra la base viva: TODO insert de product_variants falla
-- hoy, sin excepción — bloquea Fase D (tool de precios) y Fase E
-- (importación) por completo, además de cualquier alta manual de producto.
--
-- El caso UPDATE OF price no tiene este problema (la fila ya existe), así
-- que se mantiene igual. Se corrige separando el caso INSERT a un trigger
-- AFTER INSERT aparte — mismo patrón de dos triggers que la migración 57.
-- =============================================================================

create or replace function record_price_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.price is not distinct from old.price then
      return new;
    end if;
    new.price_changed_at := now();
    insert into variant_price_history (variant_id, price, currency, source)
    values (new.id, new.price, new.currency, tg_op);
    return new;
  end if;

  -- INSERT: la fila de product_variants todavía no existe en este punto
  -- (trigger BEFORE) — el registro histórico inicial se difiere a
  -- record_initial_price_history() (trigger AFTER INSERT), que sí puede
  -- referenciarla sin violar la FK.
  new.price_changed_at := now();
  return new;
end;
$$;

create or replace function record_initial_price_history()
returns trigger language plpgsql as $$
begin
  insert into variant_price_history (variant_id, price, currency, source)
  values (new.id, new.price, new.currency, 'INSERT');
  return new;
end;
$$;

drop trigger if exists trg_variant_price_history on product_variants;
create trigger trg_variant_price_history
  before insert or update of price on product_variants
  for each row execute function record_price_change();

drop trigger if exists trg_variant_price_history_initial on product_variants;
create trigger trg_variant_price_history_initial
  after insert on product_variants
  for each row execute function record_initial_price_history();

comment on function record_price_change() is
  'BEFORE trigger: en UPDATE OF price, registra el cambio en variant_price_history (la fila ya existe, sin problema de FK). En INSERT, solo fija price_changed_at — el registro histórico inicial lo hace record_initial_price_history() (AFTER INSERT), evitando la violación de variant_price_history_variant_id_fkey que tenía la versión original de este trigger (migración 56).';

comment on function record_initial_price_history() is
  'AFTER INSERT: registra el precio inicial de una variante recién creada en variant_price_history, una vez que la fila de product_variants ya existe de verdad y no viola la FK. Complementa a record_price_change(), que ya no intenta hacer esto en el caso INSERT.';


-- =============================================================================
-- Verificación
-- =============================================================================

-- Un INSERT de product_variants debe funcionar y dejar un registro inicial en el historial:
-- with p as (select id from products limit 1)
-- insert into product_variants (product_id, catalog_id, sku, price)
-- select p.id, (select catalog_id from products where id = p.id), 'VERIFY-59', 10.00 from p
-- returning id;
-- -- luego: select * from variant_price_history where variant_id = '<id de arriba>';
