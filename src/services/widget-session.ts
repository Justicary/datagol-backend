import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { ElevenLabsAdapter } from './providers/ElevenLabsAdapter.js';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { checkProviderCredentials } from './entitlements.js';
import { FEATURE_KEYS } from '../types/feature-taxonomy.js';
import { USAGE_EVENT_PROVIDERS } from '../types/usage-event-provider.js';
import { USAGE_EVENT_UNIT_TYPES } from '../types/usage-event-unit-type.js';
import { LEAD_CHANNELS } from '../types/lead-enums.js';
import { withToolTimeout } from '../lib/tool-timeout.js';
import { logger } from '../lib/logger.js';

// Cortafuegos de costo (AGENTS.md, tarea "chatbot web"): un widget público
// es superficie de abuso — alguien puede automatizar conversaciones y quemar
// la cuenta del cliente. Límite por IP más laxo que el de llamadas salientes
// (voice.ts: 3/hora) porque una sesión de chat es mucho más barata que una
// llamada SIP, y muchos visitantes legítimos pueden compartir IP (NAT
// corporativo/móvil).
const WIDGET_IP_HOURLY_LIMIT = 30;
const WIDGET_IP_WINDOW_MS = 60 * 60 * 1000;
// El tope diario por organización es configurable (organizations.widget_daily_session_limit,
// resuelto en lib/widget-auth.ts) — esta ventana es la ventana de conteo, no el límite en sí.
const WIDGET_ORG_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
// No es el camino crítico de voz (routes/tools/**, presupuesto <300ms) — es
// el bootstrap de una sesión de navegador, con margen para una llamada
// síncrona a ElevenLabs (el propósito mismo de este endpoint).
const WIDGET_SESSION_TIMEOUT_MS = 5000;

const DEGRADED_RATE_LIMITED_MESSAGE =
    'Estamos recibiendo muchas conversaciones en este momento. Completa el formulario de contacto y te responderemos a la brevedad.';
const DEGRADED_PROVIDER_MESSAGE =
    'El chat no está disponible en este momento. Completa el formulario de contacto y te responderemos a la brevedad.';

export type WidgetSessionResult =
    | { status: 'ok'; signedUrl: string }
    | { status: 'degraded'; reason: 'rate_limited' | 'provider_unavailable' | 'provider_error'; message: string };

const elevenLabsAdapter = new ElevenLabsAdapter();

/**
 * Orquesta el cortafuegos de costo y la emisión del token efímero de
 * conversación de ElevenLabs para una sesión de widget ya autenticada
 * (ver `resolveWidgetOrigin`, lib/widget-auth.ts) y con el entitlement
 * `web_widget` ya verificado por el llamador (routes/widget.ts).
 */
export async function createWidgetSession(
    fastify: FastifyInstance,
    organizationId: string,
    dailySessionLimit: number,
    sourceIp: string,
    origin: string
): Promise<WidgetSessionResult> {
    const [{ count: ipAttempts }, { count: orgAttempts }] = await Promise.all([
        fastify.supabaseAdmin
            .from('widget_session_attempts')
            .select('id', { count: 'exact', head: true })
            .eq('source_ip', sourceIp)
            .gte('created_at', new Date(Date.now() - WIDGET_IP_WINDOW_MS).toISOString()),
        fastify.supabaseAdmin
            .from('widget_session_attempts')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', organizationId)
            .gte('created_at', new Date(Date.now() - WIDGET_ORG_DAILY_WINDOW_MS).toISOString()),
    ]);

    if ((ipAttempts || 0) >= WIDGET_IP_HOURLY_LIMIT || (orgAttempts || 0) >= dailySessionLimit) {
        return { status: 'degraded', reason: 'rate_limited', message: DEGRADED_RATE_LIMITED_MESSAGE };
    }

    // Se cuenta la sesión ANTES de llamar al proveedor (igual que
    // outbound_call_attempts en voice.ts): un intento bloqueado por el
    // límite no se inserta, pero uno que sí pasa cuenta de inmediato, sin
    // esperar a que el proveedor responda.
    await fastify.supabaseAdmin.from('widget_session_attempts').insert({
        organization_id: organizationId,
        source_ip: sourceIp,
    });

    const credCheck = await checkProviderCredentials(organizationId, FEATURE_KEYS.WEB_WIDGET);
    if (!credCheck.ok) {
        logger.error({ organizationId, msg: 'Widget degradado: faltan credenciales del proveedor de voz' });
        return { status: 'degraded', reason: 'provider_unavailable', message: DEGRADED_PROVIDER_MESSAGE };
    }

    const { data: org } = await fastify.supabaseAdmin
        .from('organizations')
        .select('elevenlabs_agent_id')
        .eq('id', organizationId)
        .maybeSingle();

    const agentId = org?.elevenlabs_agent_id as string | undefined;
    const apiKey = await getSecret(organizationId, SECRET_KEYS.ELEVENLABS_API_KEY);

    if (!agentId || !apiKey) {
        logger.error({ organizationId, msg: 'Widget degradado: falta elevenlabs_agent_id o api key' });
        return { status: 'degraded', reason: 'provider_unavailable', message: DEGRADED_PROVIDER_MESSAGE };
    }

    try {
        const { signedUrl } = await withToolTimeout(
            (signal) => elevenLabsAdapter.getSignedUrl(agentId, apiKey, signal),
            WIDGET_SESSION_TIMEOUT_MS
        );

        await registerWidgetSessionUsage(fastify, organizationId, origin, sourceIp);

        return { status: 'ok', signedUrl };
    } catch (err) {
        logger.error({ err, organizationId, msg: 'Widget degradado: error al obtener signed URL de ElevenLabs' });
        return { status: 'degraded', reason: 'provider_error', message: DEGRADED_PROVIDER_MESSAGE };
    }
}

/**
 * Registro de auditoría en `usage_events` con `metadata.channel = 'web'`
 * (AGENTS.md, tarea "chatbot web": "Registrar cada sesión en usage_events
 * con el canal 'web'"). `usage_events` no tiene columna `channel` — vive en
 * `metadata`, igual que `leads.channel` usa `LEAD_CHANNELS.WEB`. Sin costo
 * directo (unit_rate_usd 0): el consumo real (minutos de agente) se mide
 * aparte cuando llega el webhook de post-conversación de ElevenLabs, igual
 * que en una llamada telefónica. Un fallo aquí no debe tumbar la respuesta:
 * el token ya fue concedido y la sesión ya cuenta para el cortafuegos.
 */
async function registerWidgetSessionUsage(
    fastify: FastifyInstance,
    organizationId: string,
    origin: string,
    sourceIp: string
): Promise<void> {
    // `amount_usd` es columna generada (quantity * unit_rate_usd) en la base
    // real — verificado contra el error 428C9 al intentar insertarla a mano
    // ("cannot insert a non-DEFAULT value into column amount_usd"), no
    // asumido de db/schema.md (que no distingue columnas generadas).
    const { error } = await fastify.supabaseAdmin.from('usage_events').insert({
        organization_id: organizationId,
        provider: USAGE_EVENT_PROVIDERS.ELEVENLABS,
        unit_type: USAGE_EVENT_UNIT_TYPES.WEB_WIDGET_SESSION,
        quantity: 1,
        unit_rate_usd: 0,
        occurred_at: new Date().toISOString(),
        metadata: { channel: LEAD_CHANNELS.WEB, origin, source_ip: sourceIp },
        idempotency_key: crypto.randomUUID(),
    });

    if (error) {
        logger.error({ err: error, organizationId, msg: 'No se pudo registrar el evento de uso del widget' });
    }
}
