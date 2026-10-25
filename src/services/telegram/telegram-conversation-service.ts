import { supabaseAdmin } from '../../lib/supabase.js';
import type {
    TelegramConversationRecord,
    TelegramConversationTurn,
    TelegramHarnessStatus,
    TelegramMessageDirection,
} from '../../types/telegram.js';
import { MAX_RESULT_DIGEST_LENGTH } from './formatter.js';

export const TELEGRAM_CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 minutos
export const MAX_TELEGRAM_CONTEXT_TURNS = 3;

export interface ActiveTelegramConversation {
    conversationId: string;
    turns: TelegramConversationTurn[];
}

/**
 * Obtiene el contexto conversacional activo de un chat privado de Telegram,
 * aislado estrictamente por `(organization_id, telegram_chat_id)`.
 * Si el TTL de 30 minutos venció o si cambió la identidad vinculada,
 * reinicia el contexto a `[]`.
 */
export async function getActiveConversationContext(
    organizationId: string,
    telegramChatId: number,
    telegramIdentityId: string,
    now: Date = new Date()
): Promise<ActiveTelegramConversation> {
    const { data: existing } = await supabaseAdmin
        .from('telegram_conversations')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('telegram_chat_id', telegramChatId)
        .maybeSingle();

    if (!existing) {
        const { data: created, error } = await supabaseAdmin
            .from('telegram_conversations')
            .insert({
                organization_id: organizationId,
                telegram_chat_id: telegramChatId,
                telegram_identity_id: telegramIdentityId,
                context: [],
                context_expires_at: null,
            })
            .select('id')
            .single();

        if (error || !created) {
            throw new Error(`No se pudo inicializar la conversación de Telegram: ${error?.message}`);
        }

        return {
            conversationId: created.id as string,
            turns: [],
        };
    }

    const record = existing as TelegramConversationRecord;
    const isExpired =
        !record.context_expires_at || new Date(record.context_expires_at).getTime() <= now.getTime();
    const identityChanged =
        record.telegram_identity_id !== null && record.telegram_identity_id !== telegramIdentityId;

    if (isExpired || identityChanged) {
        await supabaseAdmin
            .from('telegram_conversations')
            .update({
                telegram_identity_id: telegramIdentityId,
                context: [],
                context_expires_at: null,
            })
            .eq('id', record.id)
            .eq('organization_id', organizationId);

        return {
            conversationId: record.id,
            turns: [],
        };
    }

    const rawTurns = Array.isArray(record.context) ? record.context : [];
    return {
        conversationId: record.id,
        turns: rawTurns.slice(-MAX_TELEGRAM_CONTEXT_TURNS),
    };
}

/**
 * Agrega un turno resuelto al contexto de la conversación conservando
 * únicamente los últimos 3 turnos y acotando `resultDigest` a <= 500 chars.
 */
export async function appendConversationTurn(
    organizationId: string,
    telegramChatId: number,
    telegramIdentityId: string,
    turn: Omit<TelegramConversationTurn, 'createdAt'>,
    now: Date = new Date()
): Promise<TelegramConversationTurn[]> {
    const active = await getActiveConversationContext(
        organizationId,
        telegramChatId,
        telegramIdentityId,
        now
    );

    const sanitizedTurn: TelegramConversationTurn = {
        question: turn.question.slice(0, 500),
        intent: turn.intent,
        parameters: turn.parameters,
        period: turn.period,
        resultDigest: turn.resultDigest.slice(0, MAX_RESULT_DIGEST_LENGTH),
        createdAt: now.toISOString(),
    };

    const updatedTurns = [...active.turns, sanitizedTurn].slice(-MAX_TELEGRAM_CONTEXT_TURNS);
    const expiresAt = new Date(now.getTime() + TELEGRAM_CONTEXT_TTL_MS).toISOString();

    await supabaseAdmin
        .from('telegram_conversations')
        .update({
            telegram_identity_id: telegramIdentityId,
            context: updatedTurns,
            context_expires_at: expiresAt,
        })
        .eq('id', active.conversationId)
        .eq('organization_id', organizationId);

    return updatedTurns;
}

/**
 * Limpia manualmente el contexto conversacional de un chat (comando `/nuevo`).
 */
export async function clearConversationContext(
    organizationId: string,
    telegramChatId: number
): Promise<void> {
    await supabaseAdmin
        .from('telegram_conversations')
        .update({
            context: [],
            context_expires_at: null,
        })
        .eq('organization_id', organizationId)
        .eq('telegram_chat_id', telegramChatId);
}

export interface RecordTelegramMessageParams {
    organizationId: string;
    conversationId?: string | null;
    telegramIdentityId?: string | null;
    direction: TelegramMessageDirection;
    telegramUpdateId?: number | null;
    telegramMessageId?: number | null;
    intent?: string | null;
    harnessStatus?: TelegramHarnessStatus | null;
    executionTimeMs?: number | null;
    error?: string | null;
}

/**
 * Registra un asiento en la bitácora operativa `telegram_messages` (sin almacenar
 * el texto crudo de la conversación ni PII innecesaria).
 */
export async function recordTelegramMessage(params: RecordTelegramMessageParams): Promise<void> {
    await supabaseAdmin.from('telegram_messages').insert({
        organization_id: params.organizationId,
        conversation_id: params.conversationId ?? null,
        telegram_identity_id: params.telegramIdentityId ?? null,
        direction: params.direction,
        telegram_update_id: params.telegramUpdateId ?? null,
        telegram_message_id: params.telegramMessageId ?? null,
        intent: params.intent ?? null,
        harness_status: params.harnessStatus ?? null,
        execution_time_ms: params.executionTimeMs ?? null,
        error: params.error ?? null,
    });
}
