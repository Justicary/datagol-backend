import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { validateEnv } from './config/env.js';
import supabasePlugin from './plugins/supabase.js';
import pgBossPlugin from './plugins/pg-boss.js';
import entitlementsPlugin from './plugins/entitlements.js';
import adminFeaturesRoutes from './routes/admin/features.js';
import adminPermissionsRoutes from './routes/admin/permissions.js';
import adminMeteringRoutes from './routes/admin/metering.js';
import adminOrganizationsRoutes from './routes/admin/organizations.js';
import adminPlansRoutes from './routes/admin/plans.js';
import adminFactoryResetRoutes from './routes/admin/factory-reset.js';
import adminReportsRoutes from './routes/admin/reports.js';
import adminEmailAccountsRoutes from './routes/admin/email-accounts.js';
import plansRoutes from './routes/plans.js';
import organizationRoutes from './routes/organization.js';
import organizationOnboardingRoutes from './routes/organization-onboarding.js';
import organizationMembersRoutes from './routes/organization-members.js';
import contactsRoutes from './routes/contacts.js';
import contactsCrmRoutes from './routes/contacts-crm.js';
import organizationMetricsRoutes from './routes/organization-metrics.js';
import organizationEmailRoutes from './routes/organization-email.js';
import organizationThankYouRoutes from './routes/organization-thank-you.js';
import organizationLlmRoutes from './routes/organization-llm.js';
import organizationReportsRoutes from './routes/organization-reports.js';
import organizationCompetitorSitesRoutes from './routes/organization-competitor-sites.js';
import organizationAttachmentsRoutes from './routes/organization-attachments.js';
import voiceRoutes from './routes/voice.js';
import { elevenLabsWebhookRoutes } from './routes/elevenlabs.js';
import { elevenLabsPostCallWebhookRoutes } from './routes/webhooks/elevenlabs.js';
import { toolRoutes } from './routes/tools/index.js';
import { uploadRoutes } from './routes/upload.js';
import { registerJobs } from './jobs/index.js';

/**
 * Fabrica y configura la instancia principal de la aplicación Fastify.
 */
export async function buildApp() {
    // 1.1 Validación estricta de variables de entorno al arranque
    validateEnv();

    // Configuración del servidor Fastify con Pino Logger y Redacción de Secretos
    const app = Fastify({
        logger: {
            level: 'info',
            redact: [
                'req.headers.authorization',
                '*.api_key',
                '*.secret',
                '*.secret_key',
                '*.token',
                'password',
                'authorization',
                'elevenlabs_api_key',
                'telnyx_api_key',
                'whatsapp_access_token',
                'llm_api_key',
            ],
        },
    });

    // Capturar el cuerpo crudo (rawBody) de la petición HTTP para validación exacta de firmas HMAC
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        try {
            const raw = body.toString('utf8');
            (req as any).rawBody = raw;
            const json = raw.trim() ? JSON.parse(raw) : {};
            done(null, json);
        } catch (err: any) {
            err.statusCode = 400;
            done(err, undefined);
        }
    });

    // Registrar soporte de carga de archivos multipart/form-data
    await app.register(multipart, {
        limits: {
            fileSize: 10 * 1024 * 1024, // Límite de 10 MB
        },
    });

    // Soporte para CORS básico mediante hooks de Fastify
    app.addHook('onRequest', async (request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-organization-id, x-tenant-id');

        if (request.method === 'OPTIONS') {
            return reply.status(204).send();
        }
    });

    // Manejador de errores global
    app.setErrorHandler((error: any, request, reply) => {
        app.log.error(error);
        const statusCode = error.statusCode || 500;
        return reply.status(statusCode).send({
            error: error.name || 'InternalServerError',
            message: error.message || 'Ocurrió un error no controlado en el servidor',
            statusCode,
        });
    });

    // 1.2 & 1.5 Registro de plugins de infraestructura
    await app.register(supabasePlugin);
    await app.register(pgBossPlugin);
    await app.register(entitlementsPlugin);

    // Fase 2.2 — Registro de workers de pg-boss (process-call-completed, ...)
    await registerJobs(app);

    // Liveness Probe (/health): verifica únicamente que la aplicación esté viva (sin dependencias).
    app.get('/health', async (request, reply) => {
        return reply.status(200).send({
            status: 'ok',
            service: 'datagol-backend',
            timestamp: new Date().toISOString(),
        });
    });

    // Readiness Probe (/ready): verifica honestamente la base de datos (Supabase) y la cola (pg-boss).
    app.get('/ready', async (request, reply) => {
        let dbConnected = false;
        let queueConnected = false;
        let dbError: string | null = null;
        let queueError: string | null = null;

        // 1. Verificar base de datos (Supabase)
        try {
            const { error } = await app.supabaseAdmin
                .from('organizations')
                .select('count', { count: 'exact', head: true });

            if (error) {
                dbError = error.message;
            } else {
                dbConnected = true;
            }
        } catch (err: unknown) {
            dbError = err instanceof Error ? err.message : String(err);
        }

        // 2. Verificar cola (pg-boss)
        try {
            if (app.pgBoss) {
                await app.pgBoss.getQueues();
                queueConnected = true;
            } else {
                queueError = 'El plugin pg-boss no está disponible';
            }
        } catch (err: unknown) {
            queueError = err instanceof Error ? err.message : String(err);
        }

        const isReady = dbConnected && queueConnected;
        const statusCode = isReady ? 200 : 503;

        return reply.status(statusCode).send({
            status: isReady ? 'ok' : 'unhealthy',
            service: 'datagol-backend',
            database: dbConnected ? 'connected' : 'disconnected',
            queue: queueConnected ? 'connected' : 'disconnected',
            errors: isReady ? undefined : {
                ...(dbError ? { database: dbError } : {}),
                ...(queueError ? { queue: queueError } : {}),
            },
            timestamp: new Date().toISOString(),
        });
    });

    // 1.6 Ruta de administración de features/entitlements
    await app.register(adminFeaturesRoutes);
    // Consola de permisos configurables (RBAC, docs/tasks/RBAC-permisos.md FASE D)
    await app.register(adminPermissionsRoutes);
    // Fase 3.3 — Conciliación de metering
    await app.register(adminMeteringRoutes);
    // Suspensión de organización completa y kill switch global
    await app.register(adminOrganizationsRoutes);
    // Gestión de precios/planes (fuente de verdad de /pricing)
    await app.register(adminPlansRoutes);
    // Restaurar valores de fábrica (vaciar historial de interacciones para un cliente nuevo)
    await app.register(adminFactoryResetRoutes);
    // Supervisión y bitácora de preguntas no resueltas de reportes en lenguaje natural
    await app.register(adminReportsRoutes);
    // Vinculación de buzones IMAP/SMTP por organización (integración de correo nativa)
    await app.register(adminEmailAccountsRoutes);

    // Registro modular de otros plugins y rutas de la API
    await app.register(plansRoutes);
    await app.register(organizationRoutes);
    // Onboarding de organización (self-service DFY) — reemplaza el legacy
    // POST /api/organizations/onboard eliminado de organizationRoutes.
    await app.register(organizationOnboardingRoutes);
    // Invitaciones y gestión de miembros (RBAC, docs/tasks/RBAC-permisos.md FASE C)
    await app.register(organizationMembersRoutes);
    // Borrado ARCO por contacto (derecho de cancelación/oposición LFPDPPP).
    await app.register(contactsRoutes);
    // CRM de contactos: pipeline, direcciones, notas, merge, kanban (docs/tasks/opus.md Fase D)
    await app.register(contactsCrmRoutes);
    // Métricas por canal (docs/tasks/opus.md) — GET /api/organizations/:id/metrics
    await app.register(organizationMetricsRoutes);
    // Plantillas de correo seleccionables (preview y test send)
    await app.register(organizationEmailRoutes);
    // Agradecimiento automático omnicanal y gestión de adjuntos
    await app.register(organizationThankYouRoutes);
    await app.register(organizationLlmRoutes);
    await app.register(organizationReportsRoutes);
    await app.register(organizationCompetitorSitesRoutes);
    await app.register(organizationAttachmentsRoutes);
    await app.register(voiceRoutes);
    await app.register(elevenLabsWebhookRoutes);
    await app.register(elevenLabsPostCallWebhookRoutes);
    // Fase 5 — Tool calls en vivo del agente de voz (routes/tools/**)
    await app.register(toolRoutes);
    await app.register(uploadRoutes);

    return app;
}

export default buildApp;
