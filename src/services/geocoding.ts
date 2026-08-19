import { FastifyInstance } from 'fastify';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

const GEOCODING_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const GEOCODING_TIMEOUT_MS = 5000;

export interface AddressParts {
    address: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
}

export interface GeocodeResult {
    lat: number;
    lng: number;
    formattedAddress?: string | null;
    street?: string | null;
    neighborhood?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
}

function buildFullAddress(parts: AddressParts): string | null {
    const tokens = [parts.address, parts.city, parts.state, parts.zip, parts.country]
        .map((p) => (p ?? '').trim())
        .filter((p) => p !== '');

    if (tokens.length === 0) return null;

    const full = tokens.join(', ');
    const lower = full.toLowerCase();
    // Si no contiene país explícito, añadir México para contexto del buscador
    if (!lower.includes('méxico') && !lower.includes('mexico') && !lower.includes('mx')) {
        return `${full}, México`;
    }
    return full;
}

async function resolveGoogleMapsApiKey(organizationId: string): Promise<string | null> {
    const orgKey = await getSecret(organizationId, SECRET_KEYS.GOOGLE_MAPS_KEY);
    if (orgKey) return orgKey;
    return process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_KEY || null;
}

function parseGoogleGeocodeResponse(data: any): GeocodeResult | null {
    if (data?.status !== 'OK' || !Array.isArray(data?.results) || data.results.length === 0) {
        return null;
    }

    const first = data.results[0];
    const location = first?.geometry?.location;
    if (typeof location?.lat !== 'number' || typeof location?.lng !== 'number') {
        return null;
    }

    let streetNumber: string | null = null;
    let route: string | null = null;
    let neighborhood: string | null = null;
    let city: string | null = null;
    let state: string | null = null;
    let postalCode: string | null = null;
    let country: string | null = null;

    if (Array.isArray(first.address_components)) {
        for (const comp of first.address_components) {
            const types = comp.types || [];
            if (types.includes('street_number')) streetNumber = comp.long_name;
            if (types.includes('route')) route = comp.long_name;
            if (types.includes('sublocality') || types.includes('sublocality_level_1') || types.includes('neighborhood')) {
                neighborhood = comp.long_name;
            }
            if (types.includes('locality')) {
                city = comp.long_name;
            } else if (!city && (types.includes('administrative_area_level_2') || types.includes('sublocality_level_1'))) {
                city = comp.long_name;
            }
            if (types.includes('administrative_area_level_1')) state = comp.long_name;
            if (types.includes('postal_code')) postalCode = comp.long_name;
            if (types.includes('country')) country = comp.short_name || comp.long_name;
        }
    }

    const street = [route, streetNumber].filter(Boolean).join(' ') || route || null;

    return {
        lat: location.lat,
        lng: location.lng,
        formattedAddress: first.formatted_address || null,
        street,
        neighborhood,
        city,
        state,
        postalCode,
        country: country || 'MX',
    };
}

/**
 * Geocodifica la dirección de un prospecto o cliente con la API de
 * Geocoding de Google Maps, usando la `google_maps_key` de la organización
 * (Vault) o la clave del entorno como respaldo. Nunca lanza: sin llave
 * configurada, sin dirección utilizable, o ante cualquier error del
 * proveedor, devuelve `null` y permite degradación suave.
 */
export async function geocodeAddress(
    fastify: FastifyInstance,
    organizationId: string,
    parts: AddressParts
): Promise<GeocodeResult | null> {
    const fullAddress = buildFullAddress(parts);
    if (!fullAddress) return null;

    const apiKey = await resolveGoogleMapsApiKey(organizationId);
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
        const parsed = parseGoogleGeocodeResponse(data);
        if (!parsed) {
            fastify.log.warn({ organizationId, status: data?.status, msg: 'Google Maps Geocoding no resolvió la dirección' });
            return null;
        }

        return parsed;
    } catch (err) {
        fastify.log.warn({ organizationId, err, msg: 'Excepción geocodificando dirección con Google Maps' });
        return null;
    }
}

/**
 * Geocodificación inversa: a partir de latitud y longitud, obtiene la
 * dirección normalizada y estructurada (calle, colonia, ciudad, estado, CP).
 */
export async function reverseGeocode(
    fastify: FastifyInstance,
    organizationId: string,
    lat: number,
    lng: number
): Promise<GeocodeResult | null> {
    if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
        return null;
    }

    const apiKey = await resolveGoogleMapsApiKey(organizationId);
    if (!apiKey) return null;

    try {
        const url = new URL(GEOCODING_API_URL);
        url.searchParams.set('latlng', `${lat},${lng}`);
        url.searchParams.set('key', apiKey);

        const response = await fetch(url.toString(), {
            signal: AbortSignal.timeout(GEOCODING_TIMEOUT_MS),
        });

        if (!response.ok) {
            fastify.log.warn({ organizationId, status: response.status, msg: 'Google Maps Reverse Geocoding respondió error HTTP' });
            return null;
        }

        const data = (await response.json()) as any;
        const parsed = parseGoogleGeocodeResponse(data);
        if (!parsed) {
            fastify.log.warn({ organizationId, status: data?.status, msg: 'Google Maps Reverse Geocoding no resolvió las coordenadas' });
            return null;
        }

        return parsed;
    } catch (err) {
        fastify.log.warn({ organizationId, err, msg: 'Excepción en Reverse Geocoding con Google Maps' });
        return null;
    }
}
