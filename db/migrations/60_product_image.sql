-- =============================================================================
-- Datagol — Migración 60: imagen opcional de producto
-- =============================================================================
-- Un producto puede tener, opcionalmente, una imagen (miniatura para el
-- dashboard y para reenviarla por WhatsApp junto con la respuesta del tool
-- de precio/disponibilidad). Sigue el mismo patrón que
-- organization_attachments (migración 34): bucket privado de Supabase
-- Storage, se guarda la RUTA en la base (nunca una URL pública fija), y las
-- lecturas se sirven vía URL firmada temporal
-- (services/product-image-service.ts).
--
-- A diferencia de organization_attachments, no hace falta una tabla aparte:
-- es un campo opcional de UNA imagen por producto, no un historial de
-- adjuntos — un producto reemplaza su imagen, no acumula varias.
-- =============================================================================

alter table products
  add column if not exists image_path text,
  add column if not exists image_mime_type text,
  add column if not exists image_size_bytes bigint,
  add column if not exists image_uploaded_at timestamptz;

comment on column products.image_path is
  'Ruta del objeto en el bucket privado product-images de Supabase Storage (services/product-image-service.ts). NULL si el producto no tiene imagen asignada. Nunca se expone tal cual al cliente — se sirve vía URL firmada temporal.';
