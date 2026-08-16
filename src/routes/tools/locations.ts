import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { resolveToolOrganization } from '../../lib/tool-auth.js';
import {
    toolParamsSchema,
    locationsBodySchema,
    locationsResponseSchema,
    type LocationItem,
} from '../../schemas/tool-routes.js';

function formatFullAddress(item: {
    street: string;
    interior?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
}): string {
    const streetWithInterior = item.interior ? `${item.street} Int. ${item.interior}` : item.street;
    const parts = [
        streetWithInterior,
        item.neighborhood ? `Col. ${item.neighborhood}` : null,
        item.city,
        item.state,
        item.postal_code ? `C.P. ${item.postal_code}` : null,
        item.country && item.country !== 'MX' ? item.country : null,
    ].filter(Boolean);
    return parts.join(', ');
}

function buildVerbalizableMessage(
    locations: LocationItem[],
    requestedType?: string,
    requestedLabel?: string
): string {
    if (locations.length === 0) {
        if (requestedType) {
            return `No encontré ninguna dirección registrada de tipo ${requestedType} en este momento.`;
        }
        if (requestedLabel) {
            return `No encontré ninguna ubicación con el nombre "${requestedLabel}".`;
        }
        return 'La organización no tiene direcciones registradas en este momento.';
    }

    if (locations.length === 1) {
        const loc = locations[0];
        if (requestedType === 'facturacion' || loc.addressType === 'facturacion') {
            return `Nuestra dirección de facturación es: ${loc.fullAddress}.`;
        }
        if (requestedType === 'matriz' || loc.addressType === 'matriz') {
            return `Nuestra matriz se ubica en: ${loc.fullAddress}.`;
        }
        const labelStr = loc.label ? ` (${loc.label})` : '';
        return `Nuestra dirección ${loc.isPrimary ? 'principal' : 'registrada'}${labelStr} es: ${loc.fullAddress}.`;
    }

    // Múltiples ubicaciones
    const primary = locations.find((l) => l.isPrimary) || locations[0];
    const others = locations.filter((l) => l.id !== primary.id);

    if (requestedType) {
        const listStr = locations.map((l) => (l.label ? `${l.label}: ${l.fullAddress}` : l.fullAddress)).join('; ');
        return `Contamos con las siguientes direcciones de tipo ${requestedType}: ${listStr}.`;
    }

    if (others.length > 0) {
        const otherSummaries = others.map((l) => (l.label ? `${l.label} en ${l.city || l.street}` : l.fullAddress)).join(', ');
        return `Nuestra dirección principal se ubica en: ${primary.fullAddress}. Además, contamos con sucursales en: ${otherSummaries}.`;
    }

    return `Nuestra dirección principal es: ${primary.fullAddress}.`;
}

/**
 * POST /tools/:webhookToken/locations y POST /tools/:webhookToken/branches
 * Permite al agente de ElevenLabs/Vapi consultar las direcciones físicas, matriz
 * o sucursales de la organización de forma rápida (<300ms) durante la llamada.
 */
export async function locationsToolRoute(fastify: FastifyInstance) {
    const handleLocations = async (request: FastifyRequest, reply: FastifyReply) => {
        const paramsResult = toolParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'webhookToken inválido en la ruta' });
        }

        const secretHeader = request.headers['x-tool-secret'] as string | undefined;
        const auth = await resolveToolOrganization(fastify, paramsResult.data.webhookToken, secretHeader);
        if (!auth.ok) {
            const statusCode = auth.reason === 'suspended' ? 403 : 401;
            request.log.warn({ reason: auth.reason, route: 'locations', msg: 'Tool call rechazado' });
            return reply.status(statusCode).send({
                error: statusCode === 403 ? 'Forbidden' : 'Unauthorized',
                message: auth.message,
            });
        }

        const bodyResult = locationsBodySchema.safeParse(request.body || {});
        if (!bodyResult.success) {
            return reply.status(400).send({ error: 'BadRequest', message: 'Cuerpo de la petición inválido' });
        }
        const { addressType, label } = bodyResult.data;

        let query = fastify.supabaseAdmin
            .from('contact_addresses')
            .select('id, label, address_type, is_primary, street, interior, neighborhood, city, state, postal_code, country, latitude, longitude, notes')
            .eq('organization_id', auth.organizationId)
            .is('contact_id', null)
            .is('archived_at', null)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: true });

        if (addressType) {
            query = query.eq('address_type', addressType);
        }
        if (label) {
            query = query.ilike('label', `%${label}%`);
        }

        const { data: rows, error: dbError } = await query;
        if (dbError) {
            request.log.error({ organizationId: auth.organizationId, err: dbError.message, msg: 'Error consultando direcciones de organización' });
            return reply.status(200).send(
                locationsResponseSchema.parse({
                    locations: [],
                    primaryLocation: null,
                    message: 'No puedo consultar la ubicación en este momento, ¿te llamo de vuelta?',
                })
            );
        }

        const locations: LocationItem[] = (rows || []).map((r) => {
            const fullAddress = formatFullAddress({
                street: r.street,
                interior: r.interior,
                neighborhood: r.neighborhood,
                city: r.city,
                state: r.state,
                postal_code: r.postal_code,
                country: r.country,
            });

            return {
                id: r.id,
                label: r.label,
                addressType: r.address_type,
                isPrimary: Boolean(r.is_primary),
                street: r.street,
                interior: r.interior,
                neighborhood: r.neighborhood,
                city: r.city,
                state: r.state,
                postalCode: r.postal_code,
                country: r.country || 'MX',
                latitude: r.latitude !== null ? Number(r.latitude) : null,
                longitude: r.longitude !== null ? Number(r.longitude) : null,
                fullAddress,
                notes: r.notes,
            };
        });

        const primaryLocation = locations.find((l) => l.isPrimary) || (locations.length > 0 ? locations[0] : null);
        const message = buildVerbalizableMessage(locations, addressType, label);

        return reply.status(200).send(
            locationsResponseSchema.parse({
                locations,
                primaryLocation,
                message,
            })
        );
    };

    fastify.post('/tools/:webhookToken/locations', handleLocations);
    fastify.post('/tools/:webhookToken/branches', handleLocations);
}
