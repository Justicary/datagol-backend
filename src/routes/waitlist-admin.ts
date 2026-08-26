import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { getOrganizationFeatures } from '../services/entitlements.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { ALL_WAITLIST_STATUSES, WAITLIST_STATUSES, isWaitlistStatus } from '../types/waitlist.js';
import { orgIdParamsSchema } from '../schemas/contacts-crm.js';

// Sin filtro explícito, se muestra la cola activa (lo que un tablero de
// "lista de espera" quiere ver por defecto) — no el historial completo de
// ofertas ya resueltas. El frontend pide explícitamente
// ?status=confirmada,rechazada,expirada,cancelada para una pestaña de
// historial.
const DEFAULT_STATUSES: readonly string[] = [WAITLIST_STATUSES.PENDIENTE, WAITLIST_STATUSES.OFERTADA];

const waitlistListQuerySchema = z.object({
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `GET /api/organizations/:id/waitlist` (docs/tasks/waitlist_confirmacion_masiva.md).
 * Listado paginado de `appointment_waitlist` para el tablero de lista de
 * espera del dashboard — no existía en el diseño original (B1-B4 solo
 * cubrían captura, matchmaking, confirmación pública y confirmación masiva;
 * ninguno un GET de lectura), se agregó al documentar la feature para que
 * datagol-frontend tenga algo real contra qué cablear la tabla.
 *
 * Orden: `created_at` ascendente dentro del filtro de `status` (FIFO real,
 * paginable con LIMIT/OFFSET). NO replica el orden de prioridad que usa
 * `waitlist-engine.ts` para ofertar (alta/normal/baja intercalado con
 * created_at) — ese orden no es expresable como `ORDER BY` de columna sin
 * una vista o columna calculada, y no vale la pena para una vista de
 * lectura: el campo `priority` viaja en cada fila para que el frontend lo
 * pinte como badge/agrupador visual si lo necesita.
 */
export async function waitlistAdminRoutes(fastify: FastifyInstance) {
    fastify.get('/api/organizations/:id/waitlist', async (request, reply) => {
        const paramsResult = orgIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.VIEW_WAITLIST)) {
            return reply.status(403).send({ success: false, error: `Permiso requerido: ${PERMISSION_KEYS.VIEW_WAITLIST}` });
        }

        const features = await getOrganizationFeatures(organizationId);
        if (!features.has(FEATURE_KEYS.WAITLIST)) {
            return reply.status(403).send({
                success: false,
                error: `La función '${FEATURE_KEYS.WAITLIST}' no está habilitada para su organización.`,
                requiredFeature: FEATURE_KEYS.WAITLIST,
            });
        }

        const queryResult = waitlistListQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ success: false, error: 'Parámetros de consulta inválidos.' });
        }
        const { limit, offset } = queryResult.data;

        let statuses: string[];
        if (queryResult.data.status) {
            const requested = queryResult.data.status.split(',').map((s) => s.trim());
            const invalid = requested.filter((s) => !isWaitlistStatus(s));
            if (invalid.length > 0) {
                return reply.status(400).send({
                    success: false,
                    error: `status inválido: ${invalid.join(', ')}. Valores permitidos: ${ALL_WAITLIST_STATUSES.join(', ')}.`,
                });
            }
            statuses = requested;
        } else {
            statuses = [...DEFAULT_STATUSES];
        }

        // Lista de columnas explícita, no `select('*')`: `offer_token_hash`
        // no tiene uso legítimo en el dashboard (nadie necesita ver el hash
        // del token de confirmación) y no debe viajar en una respuesta de
        // API aunque sea de solo lectura y no reversible.
        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data, error, count } = await scopedClient
            .from('appointment_waitlist')
            .select(
                'id, organization_id, contact_id, call_log_id, conversation_id, customer_name, customer_phone, customer_email, party_size, preferred_date_start, preferred_date_end, preferred_time_start, preferred_time_end, status, priority, offered_appointment_id, offered_at, offer_expires_at, offered_slot_start, offered_slot_end, notification_channel, notes, created_at, updated_at',
                { count: 'exact' }
            )
            .eq('organization_id', organizationId)
            .in('status', statuses)
            .order('created_at', { ascending: true })
            .range(offset, offset + limit - 1);

        if (error) {
            request.log.error({ organizationId, err: error.message, msg: 'Error consultando appointment_waitlist' });
            return reply.status(500).send({ success: false, error: 'No se pudo consultar la lista de espera.' });
        }

        return reply.send({ success: true, data: { items: data ?? [], total: count ?? 0, limit, offset } });
    });
}

export default waitlistAdminRoutes;
