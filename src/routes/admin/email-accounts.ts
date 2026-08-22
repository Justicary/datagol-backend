import { FastifyPluginAsync } from 'fastify';
import { isPlatformAdmin } from '../../lib/platform-admin.js';
import { isFeatureEnabled } from '../../services/entitlements.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { validateAndSaveAccount, listAccounts, deleteAccount } from '../../services/email/email-account.service.js';
import {
    emailAccountOrgParamsSchema,
    emailAccountDeleteParamsSchema,
    emailAccountConfigBodySchema,
    listEmailAccountsResponseSchema,
    createEmailAccountResponseSchema,
} from '../../schemas/email-account.js';

/**
 * Gestión administrativa de buzones IMAP/SMTP por organización
 * (docs/tasks/native-mail-integration.md §3). Igual que
 * `organizations.ts`/`plans.ts`/`reports.ts`: protegido por
 * `isPlatformAdmin` porque el modelo Done-For-You del proyecto hace que sea
 * el equipo de Datagol quien vincula el buzón del cliente, no un dashboard
 * de self-service. `organizationId` se resuelve SIEMPRE de `:orgId` en la
 * ruta, nunca del body (AGENTS.md §5).
 */
export const adminEmailAccountsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', isPlatformAdmin);

    /**
     * GET /api/admin/email-accounts/organization/:orgId
     * Lista buzones vinculados y cupo disponible por plan.
     */
    fastify.get('/api/admin/email-accounts/organization/:orgId', async (request, reply) => {
        const paramsResult = emailAccountOrgParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El parámetro "orgId" debe ser un UUID válido.' });
        }
        const { orgId } = paramsResult.data;

        try {
            const { accounts, maxMailboxes } = await listAccounts(orgId);
            return reply.status(200).send(listEmailAccountsResponseSchema.parse({ accounts, maxMailboxes }));
        } catch (err) {
            return reply.status(500).send({
                error: 'InternalServerError',
                message: err instanceof Error ? err.message : 'Error listando buzones.',
            });
        }
    });

    /**
     * POST /api/admin/email-accounts/organization/:orgId
     * Registra y prueba un nuevo buzón IMAP/SMTP (conexión real antes de
     * persistir). Requiere la feature `email_integration` habilitada para
     * la organización — igual guarda que cualquier otro efecto con costo
     * (AGENTS.md §16).
     */
    fastify.post('/api/admin/email-accounts/organization/:orgId', async (request, reply) => {
        const paramsResult = emailAccountOrgParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'El parámetro "orgId" debe ser un UUID válido.' });
        }
        const { orgId } = paramsResult.data;

        const featureEnabled = await isFeatureEnabled(orgId, FEATURE_KEYS.EMAIL_INTEGRATION);
        if (!featureEnabled) {
            return reply.status(403).send({
                error: 'Forbidden',
                message: 'La integración de correo nativa no está habilitada para esta organización. Habilítala primero en /api/admin/features/organization/:orgId/overrides o en su plan.',
                code: 'FEATURE_DISABLED',
            });
        }

        const bodyResult = emailAccountConfigBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            const firstIssue = bodyResult.error.issues[0];
            return reply.status(400).send({
                error: 'BadRequest',
                message: firstIssue?.message || 'Los datos del buzón no son válidos.',
                details: bodyResult.error.issues,
            });
        }

        const result = await validateAndSaveAccount(orgId, bodyResult.data);
        if (!result.success) {
            return reply.status(result.statusCode).send({
                error: result.statusCode === 403 ? 'Forbidden' : 'BadRequest',
                message: result.error,
            });
        }

        return reply.status(201).send(
            createEmailAccountResponseSchema.parse({
                message: `Buzón ${result.account.emailAddress} vinculado con éxito.`,
                account: result.account,
            })
        );
    });

    /**
     * DELETE /api/admin/email-accounts/organization/:orgId/:accountId
     * Desvincula la cuenta y elimina las credenciales asociadas en Vault.
     */
    fastify.delete('/api/admin/email-accounts/organization/:orgId/:accountId', async (request, reply) => {
        const paramsResult = emailAccountDeleteParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Los parámetros "orgId"/"accountId" deben ser UUID válidos.' });
        }
        const { orgId, accountId } = paramsResult.data;

        const result = await deleteAccount(orgId, accountId);
        if (!result.success) {
            return reply.status(404).send({ error: 'NotFound', message: result.error });
        }

        return reply.status(200).send({ message: 'Buzón desvinculado con éxito.' });
    });
};

export default adminEmailAccountsRoutes;
