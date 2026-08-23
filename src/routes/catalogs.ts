import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { isFeatureEnabled } from '../services/entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { CATALOG_IMPORT_MODES, type CatalogImportMode } from '../types/catalog-import.js';
import {
    catalogOrgParamsSchema,
    catalogParamsSchema,
    productParamsSchema,
    createCatalogBodySchema,
    shareCatalogBodySchema,
    credentialGroupOrganizationsResponseSchema,
    columnMappingSchema,
    importInspectResponseSchema,
    importPreviewResponseSchema,
    importApplyResponseSchema,
    listImportsResponseSchema,
    productImageResponseSchema,
    batchProductImagesBodySchema,
    batchProductImagesResponseSchema,
    MAX_BATCH_IMAGE_PRODUCT_IDS,
    createImportMappingBodySchema,
    importMappingResponseSchema,
    listImportMappingsResponseSchema,
} from '../schemas/catalog.js';
import {
    parseCatalogFile,
    validateColumnMapping,
    buildImportPlan,
    applyImportPlan,
    loadExistingCatalogVariants,
} from '../services/catalog-import-service.js';
import { uploadProductImage, getProductImageSignedUrl, deleteProductImage, getProductImagesBatch } from '../services/product-image-service.js';

interface AuthContext {
    userId: string;
    jwt: string;
    organizationId: string;
}

const FEATURE_DISABLED_MESSAGE = 'El catálogo de productos no está habilitado para esta organización. Contacte a soporte o actualice su plan.';

/**
 * Rutas de catálogo e importación (FASE E, docs/tasks/catalogo-productos-grupos-cred.md).
 * `supabaseAdmin` bypasea RLS (service_role) — toda ruta verifica permiso,
 * feature y pertenencia al catálogo explícitamente (AGENTS.md §16 / FASE F).
 */
export async function catalogRoutes(fastify: FastifyInstance) {
    async function authorizeOrg(
        request: FastifyRequest,
        reply: FastifyReply,
        requiredPermission: string
    ): Promise<AuthContext | null> {
        const paramsResult = catalogOrgParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
            return null;
        }
        const organizationId = paramsResult.data.id;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(requiredPermission)) {
            reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${requiredPermission}" en esta organización, o no pertenece a ella.`,
                requiredPermission,
            });
            return null;
        }

        const featureEnabled = await isFeatureEnabled(organizationId, FEATURE_KEYS.PRODUCT_RAG);
        if (!featureEnabled) {
            reply.status(403).send({ success: false, error: 'Forbidden', code: 'FEATURE_DISABLED', message: FEATURE_DISABLED_MESSAGE });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId };
    }

    /**
     * Verifica pertenencia explícita al catálogo (catalog_access) — nunca se
     * confía en que `organizationId` sea el owner sin comprobarlo, ni en RLS
     * (esta consulta usa supabaseAdmin). Devuelve `null` y ya respondió si
     * el catálogo no existe o la organización no tiene acceso.
     */
    async function authorizeCatalog(
        request: FastifyRequest,
        reply: FastifyReply,
        requiredPermission: string,
        requireEdit: boolean
    ): Promise<(AuthContext & { catalogId: string }) | null> {
        const paramsResult = catalogParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id"/"catalogId" deben ser UUID válidos.' });
            return null;
        }

        const ctx = await authorizeOrg(request, reply, requiredPermission);
        if (!ctx) return null;

        const { catalogId } = paramsResult.data;
        const { data: access, error } = await fastify.supabaseAdmin
            .from('catalog_access')
            .select('can_edit')
            .eq('catalog_id', catalogId)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();

        if (error || !access) {
            reply.status(404).send({ success: false, error: 'Catálogo no encontrado, o esta organización no tiene acceso a él.' });
            return null;
        }
        if (requireEdit && !access.can_edit) {
            reply.status(403).send({ success: false, error: 'Forbidden', code: 'PERMISSION_DENIED', message: 'Esta organización tiene acceso de solo lectura a este catálogo.' });
            return null;
        }

        return { ...ctx, catalogId };
    }

    /**
     * Como `authorizeCatalog`, y además verifica que `productId` pertenezca
     * de verdad a `catalogId` — el producto es un parámetro de ruta más, así
     * que se comprueba pertenencia explícita en vez de confiar en el UUID.
     */
    async function authorizeProduct(
        request: FastifyRequest,
        reply: FastifyReply,
        requiredPermission: string,
        requireEdit: boolean
    ): Promise<(AuthContext & { catalogId: string; productId: string }) | null> {
        const paramsResult = productParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id"/"catalogId"/"productId" deben ser UUID válidos.' });
            return null;
        }

        const ctx = await authorizeCatalog(request, reply, requiredPermission, requireEdit);
        if (!ctx) return null;

        const { productId } = paramsResult.data;
        const { data: product, error } = await fastify.supabaseAdmin
            .from('products')
            .select('id')
            .eq('id', productId)
            .eq('catalog_id', ctx.catalogId)
            .maybeSingle();

        if (error || !product) {
            reply.status(404).send({ success: false, error: 'Producto no encontrado en este catálogo.' });
            return null;
        }

        return { ...ctx, productId };
    }

    /**
     * POST /api/organizations/:id/catalogs
     */
    fastify.post('/api/organizations/:id/catalogs', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_CATALOG);
        if (!ctx) return;

        const bodyResult = createCatalogBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "name".' });
        }

        const { data: catalog, error } = await fastify.supabaseAdmin
            .from('catalogs')
            .insert({ owner_organization_id: ctx.organizationId, name: bodyResult.data.name, description: bodyResult.data.description ?? null })
            .select('id, name, description, created_at')
            .single();

        if (error || !catalog) {
            request.log.error({ organizationId: ctx.organizationId, err: error?.message, msg: 'Error creando catálogo' });
            return reply.status(500).send({ success: false, error: 'No se pudo crear el catálogo.' });
        }

        return reply.status(201).send({ success: true, data: catalog });
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/import/inspect
     * Multipart: SOLO el archivo (sin "mode" ni "columnMapping" — detectar
     * encabezados no depende de ninguno de los dos). Paso previo al mapeo de
     * columnas en el wizard de importación: el usuario no puede mapear
     * columnas que todavía no conoce, así que este endpoint solo devuelve
     * encabezados + filas de ejemplo para armar el mapeo en el frontend.
     * Nunca calcula altas/cambios/errores — eso sigue siendo de preview/apply.
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/import/inspect', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const parsed = await parseMultipartFileOnly(request);
        if (!parsed.ok) return reply.status(400).send({ success: false, error: parsed.message });

        const { headers, rows } = await parseCatalogFile(parsed.file.buffer, parsed.file.filename, parsed.file.mimetype);

        return reply.status(200).send(
            importInspectResponseSchema.parse({
                success: true,
                data: {
                    headers: headers.filter(Boolean),
                    sampleRows: rows.slice(0, IMPORT_INSPECT_SAMPLE_ROWS),
                    totalRows: rows.length,
                },
            })
        );
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/import/preview
     * Multipart: campo de archivo + campos de texto "mode" y "columnMapping" (JSON).
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/import/preview', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const parsed = await parseMultipartImportRequest(request);
        if (!parsed.ok) return reply.status(400).send({ success: false, error: parsed.message });

        const { mode, mapping, file } = parsed;
        const parsedFile = await parseCatalogFile(file.buffer, file.filename, file.mimetype);
        const mappingErrors = validateColumnMapping(mapping, parsedFile.headers, mode);
        if (mappingErrors.length > 0) {
            return reply.status(400).send({ success: false, error: mappingErrors.join(' ') });
        }

        const { skusUpper } = await loadExistingCatalogVariants(fastify, ctx.catalogId);
        const plan = buildImportPlan(parsedFile.rows, mapping, mode, skusUpper);

        return reply.status(200).send(
            importPreviewResponseSchema.parse({
                success: true,
                data: {
                    totalRows: plan.totalRows,
                    toCreate: plan.toCreate,
                    toUpdate: plan.toUpdate,
                    errors: plan.errors,
                    duplicateSkusInFile: plan.duplicateSkusInFile,
                    imageErrors: [],
                },
            })
        );
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/import
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/import', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const parsed = await parseMultipartImportRequest(request);
        if (!parsed.ok) return reply.status(400).send({ success: false, error: parsed.message });

        const { mode, mapping, file } = parsed;
        const parsedFile = await parseCatalogFile(file.buffer, file.filename, file.mimetype);
        const mappingErrors = validateColumnMapping(mapping, parsedFile.headers, mode);
        if (mappingErrors.length > 0) {
            return reply.status(400).send({ success: false, error: mappingErrors.join(' ') });
        }

        const { skusUpper, bySkuUpper } = await loadExistingCatalogVariants(fastify, ctx.catalogId);
        const plan = buildImportPlan(parsedFile.rows, mapping, mode, skusUpper);

        const { data: importRow, error: insertErr } = await fastify.supabaseAdmin
            .from('catalog_imports')
            .insert({
                catalog_id: ctx.catalogId,
                file_name: file.filename,
                mode,
                status: 'procesando',
                rows_total: plan.totalRows,
                column_mapping: mapping,
                created_by: ctx.userId,
            })
            .select('id')
            .single();

        if (insertErr || !importRow) {
            request.log.error({ catalogId: ctx.catalogId, err: insertErr?.message, msg: 'No se pudo registrar catalog_imports' });
            return reply.status(500).send({ success: false, error: 'No se pudo registrar la importación.' });
        }

        const result = await applyImportPlan(fastify, ctx.catalogId, mode, plan, bySkuUpper);

        const finalStatus = result.rowsFailed > 0 && result.rowsCreated === 0 && result.rowsUpdated === 0 ? 'fallido' : 'completado';

        await fastify.supabaseAdmin
            .from('catalog_imports')
            .update({
                status: finalStatus,
                rows_created: result.rowsCreated,
                rows_updated: result.rowsUpdated,
                rows_failed: result.rowsFailed,
                errors: result.errors,
                completed_at: new Date().toISOString(),
            })
            .eq('id', importRow.id);

        return reply.status(200).send(
            importApplyResponseSchema.parse({
                success: true,
                data: {
                    importId: importRow.id,
                    status: finalStatus,
                    rowsTotal: plan.totalRows,
                    rowsCreated: result.rowsCreated,
                    rowsUpdated: result.rowsUpdated,
                    rowsFailed: result.rowsFailed,
                    errors: result.errors,
                    imageErrors: result.imageErrors,
                },
            })
        );
    });

    /**
     * GET /api/organizations/:id/catalogs/:catalogId/imports
     */
    fastify.get('/api/organizations/:id/catalogs/:catalogId/imports', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.VIEW_CATALOG, false);
        if (!ctx) return;

        const { data, error } = await fastify.supabaseAdmin
            .from('catalog_imports')
            .select('id, file_name, mode, status, rows_total, rows_created, rows_updated, rows_failed, created_at, completed_at')
            .eq('catalog_id', ctx.catalogId)
            .order('created_at', { ascending: false });

        if (error) {
            request.log.error({ catalogId: ctx.catalogId, err: error.message, msg: 'Error listando catalog_imports' });
            return reply.status(500).send({ success: false, error: 'No se pudieron listar las importaciones.' });
        }

        return reply.status(200).send(
            listImportsResponseSchema.parse({
                success: true,
                data: (data ?? []).map((row) => ({
                    id: row.id,
                    fileName: row.file_name,
                    mode: row.mode,
                    status: row.status,
                    rowsTotal: row.rows_total,
                    rowsCreated: row.rows_created,
                    rowsUpdated: row.rows_updated,
                    rowsFailed: row.rows_failed,
                    createdAt: row.created_at,
                    completedAt: row.completed_at,
                })),
            })
        );
    });

    /**
     * GET /api/organizations/:id/credential-group/organizations
     * Organizaciones hermanas del mismo grupo de credenciales — para la UI
     * de "compartir catálogo" y "precio por sucursal" (override). La RLS de
     * `organizations` no deja verlas con un SELECT directo del cliente
     * (`org_read` solo expone las propias organizaciones activas), así que
     * se resuelve aquí con supabaseAdmin + verificación explícita.
     */
    fastify.get('/api/organizations/:id/credential-group/organizations', async (request, reply) => {
        const ctx = await authorizeOrg(request, reply, PERMISSION_KEYS.MANAGE_CATALOG);
        if (!ctx) return;

        const { data: org, error: orgError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('credential_group_id')
            .eq('id', ctx.organizationId)
            .maybeSingle();

        if (orgError || !org?.credential_group_id) {
            request.log.error({ organizationId: ctx.organizationId, err: orgError?.message, msg: 'No se pudo resolver el grupo de credenciales' });
            return reply.status(500).send({ success: false, error: 'No se pudo resolver el grupo de credenciales de esta organización.' });
        }

        const { data: siblings, error: siblingsError } = await fastify.supabaseAdmin
            .from('organizations')
            .select('id, name')
            .eq('credential_group_id', org.credential_group_id)
            .neq('id', ctx.organizationId)
            .order('name', { ascending: true });

        if (siblingsError) {
            request.log.error({ organizationId: ctx.organizationId, err: siblingsError.message, msg: 'Error listando organizaciones del grupo de credenciales' });
            return reply.status(500).send({ success: false, error: 'No se pudieron listar las organizaciones del grupo de credenciales.' });
        }

        return reply.status(200).send(credentialGroupOrganizationsResponseSchema.parse({ success: true, data: siblings ?? [] }));
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/share
     * El trigger `enforce_catalog_share_scope` (migración 56) ya impide
     * compartir fuera del grupo — aquí se traduce su excepción a un mensaje
     * claro en vez de dejar pasar el error crudo de Postgres.
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/share', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const bodyResult = shareCatalogBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "organizationId".' });
        }

        const { error } = await fastify.supabaseAdmin.from('catalog_access').upsert(
            {
                catalog_id: ctx.catalogId,
                organization_id: bodyResult.data.organizationId,
                can_edit: bodyResult.data.canEdit,
            },
            { onConflict: 'catalog_id,organization_id' }
        );

        if (error) {
            if (error.message.includes('mismo grupo de credenciales')) {
                return reply.status(400).send({ success: false, error: 'Solo se puede compartir un catálogo con organizaciones del mismo grupo de credenciales.' });
            }
            request.log.error({ catalogId: ctx.catalogId, err: error.message, msg: 'Error compartiendo catálogo' });
            return reply.status(500).send({ success: false, error: 'No se pudo compartir el catálogo.' });
        }

        return reply.status(200).send({ success: true });
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/products/images/batch
     * Firma en un solo viaje las imágenes de varios productos — pensado para
     * que una lista/tabla firme solo lo visible en pantalla, nunca todo el
     * catálogo. Solo lectura: VIEW_CATALOG, no MANAGE_CATALOG.
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/products/images/batch', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.VIEW_CATALOG, false);
        if (!ctx) return;

        const bodyResult = batchProductImagesBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({
                success: false,
                error: `Cuerpo de la petición inválido: se requiere "productIds" (arreglo de 1 a ${MAX_BATCH_IMAGE_PRODUCT_IDS} UUID).`,
            });
        }

        const images = await getProductImagesBatch(fastify, ctx.catalogId, bodyResult.data.productIds);

        return reply.status(200).send(batchProductImagesResponseSchema.parse({ success: true, data: { images } }));
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/products/:productId/image
     * Imagen opcional del producto (PNG/JPEG/WebP, 5 MB máx. — services/product-image-service.ts).
     * Sube (o reemplaza) la imagen y devuelve de inmediato una URL firmada
     * para mostrarla, igual que el patrón de organization-attachments.ts.
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/products/:productId/image', async (request, reply) => {
        const ctx = await authorizeProduct(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        let fileData;
        try {
            fileData = await request.file();
        } catch (err) {
            return reply.status(400).send({ success: false, error: `Error al leer la imagen: ${err instanceof Error ? err.message : String(err)}` });
        }
        if (!fileData) {
            return reply.status(400).send({ success: false, error: 'No se incluyó ninguna imagen en la petición.' });
        }

        const buffer = await fileData.toBuffer();
        if (!buffer || buffer.length === 0) {
            return reply.status(400).send({ success: false, error: 'La imagen subida está vacía.' });
        }

        try {
            const image = await uploadProductImage(fastify, {
                catalogId: ctx.catalogId,
                productId: ctx.productId,
                fileName: fileData.filename || 'imagen.jpg',
                fileBuffer: buffer,
            });
            const imageUrl = await getProductImageSignedUrl(fastify, image.imagePath);

            return reply.status(201).send(
                productImageResponseSchema.parse({
                    success: true,
                    data: { imageUrl, mimeType: image.mimeType, sizeBytes: image.sizeBytes, uploadedAt: image.uploadedAt },
                })
            );
        } catch (err) {
            request.log.warn({ productId: ctx.productId, err: err instanceof Error ? err.message : String(err), msg: 'Rechazo al subir imagen de producto' });
            return reply.status(400).send({ success: false, error: err instanceof Error ? err.message : 'No se pudo subir la imagen.' });
        }
    });

    /**
     * GET /api/organizations/:id/catalogs/:catalogId/products/:productId/image
     * Las URL firmadas expiran (1 hora) — este endpoint permite pedir una
     * nueva sin tener que volver a subir la imagen.
     */
    fastify.get('/api/organizations/:id/catalogs/:catalogId/products/:productId/image', async (request, reply) => {
        const ctx = await authorizeProduct(request, reply, PERMISSION_KEYS.VIEW_CATALOG, false);
        if (!ctx) return;

        const { data: product, error } = await fastify.supabaseAdmin
            .from('products')
            .select('image_path, image_mime_type, image_size_bytes, image_uploaded_at')
            .eq('id', ctx.productId)
            .eq('catalog_id', ctx.catalogId)
            .maybeSingle();

        if (error || !product || !product.image_path) {
            return reply.status(200).send(
                productImageResponseSchema.parse({ success: true, data: { imageUrl: null, mimeType: null, sizeBytes: null, uploadedAt: null } })
            );
        }

        const imageUrl = await getProductImageSignedUrl(fastify, product.image_path);
        return reply.status(200).send(
            productImageResponseSchema.parse({
                success: true,
                data: {
                    imageUrl,
                    mimeType: product.image_mime_type,
                    sizeBytes: product.image_size_bytes,
                    uploadedAt: product.image_uploaded_at,
                },
            })
        );
    });

    /**
     * DELETE /api/organizations/:id/catalogs/:catalogId/products/:productId/image
     */
    fastify.delete('/api/organizations/:id/catalogs/:catalogId/products/:productId/image', async (request, reply) => {
        const ctx = await authorizeProduct(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const success = await deleteProductImage(fastify, ctx.catalogId, ctx.productId);
        if (!success) {
            return reply.status(500).send({ success: false, error: 'No se pudo borrar la imagen del producto.' });
        }

        return reply.status(200).send({ success: true });
    });

    /**
     * GET /api/organizations/:id/catalogs/:catalogId/import-mappings
     * Mapeos de columnas guardados — evita repetir el mapeo manual en cada
     * importación cuando el cliente siempre trae el mismo formato de archivo.
     */
    fastify.get('/api/organizations/:id/catalogs/:catalogId/import-mappings', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.VIEW_CATALOG, false);
        if (!ctx) return;

        const { data, error } = await fastify.supabaseAdmin
            .from('catalog_import_mappings')
            .select('id, name, mode, column_mapping, created_at')
            .eq('catalog_id', ctx.catalogId)
            .order('created_at', { ascending: false });

        if (error) {
            request.log.error({ catalogId: ctx.catalogId, err: error.message, msg: 'Error listando catalog_import_mappings' });
            return reply.status(500).send({ success: false, error: 'No se pudieron listar los mapeos guardados.' });
        }

        return reply.status(200).send(
            listImportMappingsResponseSchema.parse({
                success: true,
                data: (data ?? []).map((row) => ({
                    id: row.id,
                    name: row.name,
                    mode: row.mode,
                    columnMapping: row.column_mapping,
                    createdAt: row.created_at,
                })),
            })
        );
    });

    /**
     * POST /api/organizations/:id/catalogs/:catalogId/import-mappings
     */
    fastify.post('/api/organizations/:id/catalogs/:catalogId/import-mappings', async (request, reply) => {
        const ctx = await authorizeCatalog(request, reply, PERMISSION_KEYS.MANAGE_CATALOG, true);
        if (!ctx) return;

        const bodyResult = createImportMappingBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: `Cuerpo de la petición inválido: ${bodyResult.error.message}` });
        }

        const { data, error } = await fastify.supabaseAdmin
            .from('catalog_import_mappings')
            .insert({
                catalog_id: ctx.catalogId,
                name: bodyResult.data.name,
                mode: bodyResult.data.mode,
                column_mapping: bodyResult.data.columnMapping,
                created_by: ctx.userId,
            })
            .select('id, name, mode, column_mapping, created_at')
            .single();

        if (error || !data) {
            request.log.error({ catalogId: ctx.catalogId, err: error?.message, msg: 'No se pudo guardar el mapeo de importación' });
            return reply.status(500).send({ success: false, error: 'No se pudo guardar el mapeo de importación.' });
        }

        return reply.status(201).send(
            importMappingResponseSchema.parse({
                success: true,
                data: { id: data.id, name: data.name, mode: data.mode, columnMapping: data.column_mapping, createdAt: data.created_at },
            })
        );
    });
}

/** Filas de ejemplo devueltas por /import/inspect para armar el mapeo de columnas en el frontend. */
const IMPORT_INSPECT_SAMPLE_ROWS = 5;

interface MultipartImportRequest {
    ok: true;
    mode: CatalogImportMode;
    mapping: import('../schemas/catalog.js').ColumnMapping;
    file: { buffer: Buffer; filename: string; mimetype: string };
}
interface MultipartImportError {
    ok: false;
    message: string;
}

interface MultipartFileOnlyRequest {
    ok: true;
    file: { buffer: Buffer; filename: string; mimetype: string };
}

/**
 * Igual que `parseMultipartImportRequest`, pero para /import/inspect: solo
 * recoge el archivo, sin exigir (ni siquiera leer) "mode" ni "columnMapping"
 * — en este paso del wizard todavía no existen.
 */
async function parseMultipartFileOnly(request: FastifyRequest): Promise<MultipartFileOnlyRequest | MultipartImportError> {
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    try {
        for await (const part of request.parts()) {
            if (part.type === 'file') {
                file = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
            }
        }
    } catch (err) {
        return { ok: false, message: `No se pudo leer la petición multipart: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!file) return { ok: false, message: 'No se incluyó ningún archivo en la petición.' };
    return { ok: true, file };
}

/**
 * Recoge el archivo Y los campos de texto ("mode", "columnMapping") de una
 * misma petición multipart/form-data — `request.file()` de @fastify/multipart
 * solo da acceso al archivo, así que se itera `request.parts()` a mano.
 */
async function parseMultipartImportRequest(request: FastifyRequest): Promise<MultipartImportRequest | MultipartImportError> {
    let mode: CatalogImportMode = CATALOG_IMPORT_MODES.COMPLETO;
    let columnMappingRaw: string | null = null;
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null;

    try {
        for await (const part of request.parts()) {
            if (part.type === 'file') {
                file = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
            } else if (part.fieldname === 'mode') {
                mode = part.value as CatalogImportMode;
            } else if (part.fieldname === 'columnMapping') {
                columnMappingRaw = part.value as string;
            }
        }
    } catch (err) {
        return { ok: false, message: `No se pudo leer la petición multipart: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!file) return { ok: false, message: 'No se incluyó ningún archivo en la petición.' };
    if (mode !== CATALOG_IMPORT_MODES.COMPLETO && mode !== CATALOG_IMPORT_MODES.SOLO_PRECIOS) {
        return { ok: false, message: `"mode" debe ser "${CATALOG_IMPORT_MODES.COMPLETO}" o "${CATALOG_IMPORT_MODES.SOLO_PRECIOS}".` };
    }
    if (!columnMappingRaw) return { ok: false, message: 'Falta el campo "columnMapping" (JSON con el mapeo de columnas).' };

    let mappingJson: unknown;
    try {
        mappingJson = JSON.parse(columnMappingRaw);
    } catch {
        return { ok: false, message: 'El campo "columnMapping" no es JSON válido.' };
    }

    const mappingResult = columnMappingSchema.safeParse(mappingJson);
    if (!mappingResult.success) {
        return { ok: false, message: `El mapeo de columnas es inválido: ${mappingResult.error.message}` };
    }

    return { ok: true, mode, mapping: mappingResult.data, file };
}

export default catalogRoutes;
