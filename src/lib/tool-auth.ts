import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { getSecret } from '../services/secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';

export type ToolAuthResult =
    | { ok: true; organizationId: string; calEventTypeId: number | null }
    | { ok: false; reason: 'invalid_token'; message: string }
    | { ok: false; reason: 'missing_secret'; message: string };

/**
 * Resuelve el tenant de una llamada a `routes/tools/**` y verifica su
 * autenticación, en ese orden exacto (AGENTS.md §5.1: prohibido leer
 * `organization_id` del cuerpo de la petición, que el LLM puede alucinar o
 * un tercero falsificar).
 *
 * 1. `webhookToken` de la ruta resuelve la organización — mismo campo e
 *    idéntico principio que `POST /webhooks/elevenlabs/:webhookToken`
 *    (routes/webhooks/elevenlabs.ts): un identificador de enrutamiento no
 *    criptográfico, consultado ANTES de tocar el cuerpo.
 * 2. El encabezado `x-tool-secret` se compara en tiempo constante contra
 *    `tool_webhook_secret` (organization_secrets/Vault). ElevenLabs no firma
 *    HMAC las llamadas a "webhook tools" — solo soporta adjuntar un header
 *    estático configurado una vez en el dashboard — así que esta es la única
 *    verificación de autenticidad disponible en este camino.
 */
export async function resolveToolOrganization(
    fastify: FastifyInstance,
    webhookToken: string,
    secretHeader: string | undefined
): Promise<ToolAuthResult> {
    const { data: org, error } = await fastify.supabaseAdmin
        .from('organizations')
        .select('id, cal_event_type_id')
        .eq('webhook_token', webhookToken)
        .maybeSingle();

    if (error || !org) {
        return { ok: false, reason: 'invalid_token', message: 'Token de herramienta inválido' };
    }

    const organizationId = org.id as string;
    const expectedSecret = await getSecret(organizationId, SECRET_KEYS.TOOL_WEBHOOK_SECRET);

    if (!expectedSecret || !secretHeader || !timingSafeEqualStrings(secretHeader, expectedSecret)) {
        return { ok: false, reason: 'missing_secret', message: 'Secreto de herramienta inválido o ausente' };
    }

    return {
        ok: true,
        organizationId,
        calEventTypeId: org.cal_event_type_id === null || org.cal_event_type_id === undefined ? null : Number(org.cal_event_type_id),
    };
}

function timingSafeEqualStrings(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufferA, bufferB);
}
