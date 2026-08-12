import { FastifyInstance } from 'fastify';

export type WidgetOriginAuthResult =
    | { ok: true; organizationId: string; dailySessionLimit: number }
    | {
          ok: false;
          reason: 'missing_origin' | 'invalid_key' | 'disabled' | 'origin_mismatch' | 'suspended';
          message: string;
      };

/**
 * Resuelve el tenant de un `POST /api/widget/session` y valida su
 * autenticación, en ese orden exacto (mismo criterio que
 * `resolveToolOrganization` en lib/tool-auth.ts):
 *
 * 1. `publicKey` (cuerpo, no secreto) resuelve la fila de `widget_origins` —
 *    y con ella, la organización y el origen exacto autorizado.
 * 2. El encabezado `Origin` de la petición debe coincidir EXACTAMENTE con el
 *    origen registrado para esa `publicKey`. Un widget no puede portar un
 *    secreto (el JS es visible en el navegador) — el origen del navegador,
 *    que el servidor sí puede verificar de forma confiable, es el único
 *    factor de autenticación disponible.
 * 3. La suspensión de la organización se verifica DESPUÉS de resolver
 *    origen/clave (nunca antes): comprobarlo antes filtraría a un llamador
 *    no autenticado si la organización existe y está suspendida.
 */
export async function resolveWidgetOrigin(
    fastify: FastifyInstance,
    publicKey: string,
    originHeader: string | undefined
): Promise<WidgetOriginAuthResult> {
    if (!originHeader) {
        return { ok: false, reason: 'missing_origin', message: 'Encabezado Origin ausente en la petición.' };
    }

    const { data: row, error } = await fastify.supabaseAdmin
        .from('widget_origins')
        .select('organization_id, origin, enabled')
        .eq('public_key', publicKey)
        .maybeSingle();

    if (error || !row) {
        return { ok: false, reason: 'invalid_key', message: 'Clave pública de widget inválida.' };
    }
    if (!row.enabled) {
        return { ok: false, reason: 'disabled', message: 'Este widget está deshabilitado.' };
    }
    if (row.origin !== originHeader) {
        return { ok: false, reason: 'origin_mismatch', message: 'Este origen no está autorizado para esta clave pública.' };
    }

    const organizationId = row.organization_id as string;

    const { data: org, error: orgErr } = await fastify.supabaseAdmin
        .from('organizations')
        .select('status, widget_daily_session_limit')
        .eq('id', organizationId)
        .maybeSingle();

    if (orgErr || !org) {
        return { ok: false, reason: 'invalid_key', message: 'Clave pública de widget inválida.' };
    }
    if (org.status === 'suspended') {
        return { ok: false, reason: 'suspended', message: 'Esta organización tiene su implementación suspendida.' };
    }

    return {
        ok: true,
        organizationId,
        dailySessionLimit: org.widget_daily_session_limit as number,
    };
}

const ORIGIN_REGISTRY_CACHE_TTL_MS = 30 * 1000;
const originRegistryCache = new Map<string, { registered: boolean; expiresAt: number }>();

/**
 * Verifica solo EXISTENCIA de un origen registrado (sin resolver a qué
 * organización pertenece) — usado por el hook CORS de `routes/widget.ts`
 * para decidir el encabezado `Access-Control-Allow-Origin` durante el
 * preflight `OPTIONS`, que llega sin cuerpo y por lo tanto sin `publicKey`.
 * La autorización real y completa ocurre en `resolveWidgetOrigin` dentro
 * del handler `POST`. Cacheado en memoria con TTL corto: se consulta en
 * cada preflight, y este dato no necesita ser instantáneo.
 */
export async function isOriginRegistered(fastify: FastifyInstance, origin: string): Promise<boolean> {
    const now = Date.now();
    const cached = originRegistryCache.get(origin);
    if (cached && cached.expiresAt > now) {
        return cached.registered;
    }

    const { data } = await fastify.supabaseAdmin
        .from('widget_origins')
        .select('id')
        .eq('origin', origin)
        .eq('enabled', true)
        .limit(1)
        .maybeSingle();

    const registered = !!data;
    originRegistryCache.set(origin, { registered, expiresAt: now + ORIGIN_REGISTRY_CACHE_TTL_MS });
    return registered;
}

export function clearOriginRegistryCache(): void {
    originRegistryCache.clear();
}

/**
 * Normaliza una URL de origen a la forma exacta `esquema://host[:puerto]`
 * (sin ruta, query ni slash final) — la misma forma que los navegadores
 * envían en el encabezado `Origin`, vía el getter `URL.origin`. Rechaza
 * cualquier esquema distinto de http/https.
 */
export function normalizeOrigin(input: string): string | null {
    try {
        const url = new URL(input);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}
