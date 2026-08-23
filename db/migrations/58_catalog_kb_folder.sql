-- =============================================================================
-- Datagol — Migración 58: carpeta de KB por catálogo
-- =============================================================================
-- FASE C.2 (docs/tasks/catalogo-productos-grupos-cred.md): "Usar una carpeta
-- por catálogo. El agente siempre accede a las carpetas mediante RAG y nunca
-- las coloca en el prompt, así que la carpeta garantiza el modo correcto sin
-- depender de la configuración por documento."
--
-- kb_folder_id se resuelve perezosamente (src/jobs/sync-catalog-kb.ts): la
-- primera vez que un producto de un catálogo se sincroniza, si el catálogo
-- no tiene carpeta, el job la crea en ElevenLabs y la guarda aquí. Sembrar
-- una carpeta por catálogo en esta migración no seria correcto: crearla
-- requiere la API key del owner del grupo, que esta migración no tiene forma
-- de invocar.
-- =============================================================================

alter table catalogs
  add column if not exists kb_folder_id text;

comment on column catalogs.kb_folder_id is
  'Id de la carpeta de knowledge base de ElevenLabs para este catálogo (FASE C.2). Se resuelve perezosamente en src/jobs/sync-catalog-kb.ts la primera vez que hay algo que sincronizar — NULL hasta entonces.';
