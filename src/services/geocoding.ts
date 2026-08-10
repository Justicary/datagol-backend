import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

const GEOCODING_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GEOCODING_TIMEOUT_MS = 5000;

export interface AddressParts {
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
}

export interface GeocodeResult {
    lat: number;
    lng: number;
}

function buildFullAddress(parts: AddressParts): string | null {
    const joined = [parts.address, parts.city, parts.state, parts.zip]
        .map((p) => (p ?? '').trim())
        .filter((p) => p !== '')
        .join(', ');
    return joined === '' ? null : joined;
}

/**
 * Geocodifica la dirección de servicio de un prospecto con la API de
 * Geocoding de Google Maps, usando la `google_maps_key` de la organización
 * (Vault, opcional). Nunca lanza: sin llave configurada, sin dirección
 * utilizable, o ante cualquier error del proveedor, devuelve `null` y deja
 * que el llamador persista `customer_lat`/`customer_lng` en NULL — la
 * captura de la dirección en texto no depende de que la geocodificación
 * tenga éxito (AGENTS.md, regla de degradación verbalizable/no bloqueante,
 * mismo criterio que services/cal-com-tool-client.ts).
 */
export async function geocodeAddress(
    fastify: FastifyInstance,
    organizationId: string,
    parts: AddressParts
): Promise<GeocodeResult | null> {
    const fullAddress = buildFullAddress(parts);
    if (!fullAddress) return null;

    const apiKey = await getSecret(organizationId, SECRET_KEYS.GOOGLE_MAPS_KEY);
    if (!apiKey) return null;

    try {
        const url = new URL(GEOCODING_API_URL);
        url.searchParams.set('address', fullAddress);
        url.searchParams.set('key', apiKey);

        const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(GEOCODING_TIMEOUT_MS),
        });

        if (!response.ok) {
            fastify.log.warn({ organizationId, status: response.status, msg: 'Google Maps Geocoding respondió error HTTP' });
            return null;
        }

        const data = (await response.json()) as any;
        if (data?.status !== 'OK') {
            fastify.log.warn({ organizationId, status: data?.status, msg: 'Google Maps Geocoding no resolvió la dirección' });
            return null;
        }

        const location = data?.results?.[0]?.geometry?.location;
        if (typeof location?.lat !== 'number' || typeof location?.lng !== 'number') {
            fastify.log.warn({ organizationId, msg: 'Google Maps Geocoding respondió OK sin coordenadas utilizables' });
            return null;
        }

        return { lat: location.lat, lng: location.lng };
    } catch (err) {
        fastify.log.warn({ organizationId, err, msg: 'Excepción geocodificando dirección con Google Maps' });
        return null;
    }
}
