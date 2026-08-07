import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { validateEnv } from './config/env.js';
import supabasePlugin from './plugins/supabase.js';
import pgBossPlugin from './plugins/pg-boss.js';
import entitlementsPlugin from './plugins/entitlements.js';
import adminFeaturesRoutes from './routes/admin/features.js';
import adminMeteringRoutes from './routes/admin/metering.js';
import organizationRoutes from './routes/organization.js';
import organizationOnboardingRoutes from './routes/organization-onboarding.js';
import vapiRoutes from './routes/vapi.js';
import calendarRoutes from './routes/calendar.js';
import voiceRoutes from './routes/voice.js';
import { elevenLabsWebhookRoutes } from './routes/elevenlabs.js';
import { elevenLabsPostCallWebhookRoutes } from './routes/webhooks/elevenlabs.js';
import { elevenLabsToolsRoutes } from './routes/elevenlabs-tools.js';
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
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

    // Ruta de verificación de estado y salud (Healthcheck)
    app.get('/health', async (request, reply) => {
        try {
            const { error } = await app.supabaseAdmin
                .from('organizations')
                .select('count', { count: 'exact', head: true });

            if (error) {
                return reply.status(500).send({
                    status: 'error',
                    message: 'Error al conectar con la base de datos de Supabase',
                    details: error.message,
                });
            }

            return reply.status(200).send({
                status: 'ok',
                service: 'datagol-backend',
                database: 'connected',
                timestamp: new Date().toISOString(),
            });
        } catch (err: any) {
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error al verificar salud del servicio',
            });
        }
    });

    // 1.6 Ruta de administración de features/entitlements
    await app.register(adminFeaturesRoutes);
    // Fase 3.3 — Conciliación de metering
    await app.register(adminMeteringRoutes);

    // Registro modular de otros plugins y rutas de la API
    await app.register(organizationRoutes);
    // Onboarding de organización (self-service DFY) — reemplaza el legacy
    // POST /api/organizations/onboard eliminado de organizationRoutes.
    await app.register(organizationOnboardingRoutes);
    await app.register(vapiRoutes);
    await app.register(calendarRoutes);
    await app.register(voiceRoutes);
    await app.register(elevenLabsWebhookRoutes);
    await app.register(elevenLabsPostCallWebhookRoutes);
    await app.register(elevenLabsToolsRoutes);
    // Fase 5 — Tool calls en vivo del agente de voz (routes/tools/**)
    await app.register(toolRoutes);
    await app.register(uploadRoutes);

    return app;
}

export default buildApp;
