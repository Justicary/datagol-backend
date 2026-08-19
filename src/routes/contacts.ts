import { FastifyInstance } from 'fastify';
import { requireAuthenticatedUser } from '../lib/organization-auth.js';
import { getPermissionsForUser } from '../services/permission-service.js';
import { PERMISSION_KEYS } from '../types/permission-keys.js';
import { contactErasureParamsSchema, contactErasureResponseSchema } from '../schemas/contacts.js';

/**
 * Endpoints de contactos. Hoy solo el borrado ARCO — la anonimización en sí
 * vive en `public.erase_contact_pii` (db/migrations/11 y 17), este endpoint
 * es la puerta HTTP autenticada para que el equipo de la PyME cliente pueda
 * atender una solicitud de un titular desde el dashboard, sin depender de
 * que el frontend invoque el RPC directo con supabase-js (que sigue
 * funcionando, mismo RPC — este endpoint no lo reemplaza, le da una
 * superficie documentada y con Zod, consistente con el resto de
 * `routes/organization-onboarding.ts`).
 */
export async function contactsRoutes(fastify: FastifyInstance) {
    /**
     * POST /api/organizations/:id/contacts/:contactId/erase
     * Borrado ARCO (derecho de cancelación/oposición): anonimiza identidad
     * en contacts/leads/call_logs/appointments, purga transcript/summary del
     * contacto y redacta el webhook_events asociado. Conserva
     * contacts.phone_e164 (supresión de opted_out) y todo campo operativo.
     */
    fastify.post('/api/organizations/:id/contacts/:contactId/erase', async (request, reply) => {
        const paramsResult = contactErasureParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id" y "contactId" deben ser UUID válidos.' });
        }
        const { id: organizationId, contactId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const permissions = await getPermissionsForUser(organizationId, auth.userId, auth.jwt);
        if (!permissions.has(PERMISSION_KEYS.ERASE_CONTACT_DATA)) {
            return reply.status(403).send({
                success: false,
                error: 'Forbidden',
                code: 'PERMISSION_DENIED',
                message: `No tiene el permiso "${PERMISSION_KEYS.ERASE_CONTACT_DATA}" en esta organización, o no pertenece a ella.`,
                requiredPermission: PERMISSION_KEYS.ERASE_CONTACT_DATA,
            });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);

        // El :id de la URL es la fuente de verdad de a qué organización
        // pertenece esta operación — erase_contact_pii solo verifica que el
        // llamador pertenezca a la organización REAL del contacto, sin saber
        // nada de la URL. Sin este chequeo, un usuario que también fuera
        // miembro de otra organización podría borrar un contacto ajeno a
        // :id con una URL que sugiere lo contrario — no es una escalación
        // real (sigue necesitando pertenecer a la organización dueña del
        // contacto), pero rompe el contrato de la ruta.
        const { data: contact, error: contactError } = await scopedClient
            .from('contacts')
            .select('id, organization_id')
            .eq('id', contactId)
            .maybeSingle();

        if (contactError || !contact || contact.organization_id !== organizationId) {
            return reply.status(404).send({ success: false, error: 'Contacto no encontrado en esta organización.' });
        }

        const { error } = await scopedClient.rpc('erase_contact_pii', { p_contact_id: contactId });

        if (error) {
            const notFound = error.message.includes('Contacto no encontrado');
            const forbidden = error.message.includes('No tienes permiso');
            request.log.warn({ organizationId, contactId, err: error.message }, 'Borrado ARCO rechazado por erase_contact_pii');
            return reply.status(notFound ? 404 : forbidden ? 403 : 500).send({
                success: false,
                error: notFound
                    ? 'Contacto no encontrado.'
                    : forbidden
                      ? 'No tienes permiso para borrar este contacto.'
                      : 'No se pudo completar el borrado.',
            });
        }

        request.log.info({ organizationId, contactId, userId: auth.userId }, 'Borrado ARCO completado');

        return reply.send(
            contactErasureResponseSchema.parse({
                success: true,
                data: { contactId, erasedAt: new Date().toISOString() },
            })
        );
    });
}

export default contactsRoutes;
