import type { NlIntentKey } from './natural-reports.js';
import type { NlPeriodParam } from '../schemas/natural-reports.js';

export const TELEGRAM_CONNECTION_STATUSES = {
    ACTIVE: 'active',
    DISABLED: 'disabled',
    ERROR: 'error',
} as const;

export type TelegramConnectionStatus =
    (typeof TELEGRAM_CONNECTION_STATUSES)[keyof typeof TELEGRAM_CONNECTION_STATUSES];

export const TELEGRAM_IDENTITY_STATUSES = {
    ACTIVE: 'active',
    REVOKED: 'revoked',
} as const;

export type TelegramIdentityStatus =
    (typeof TELEGRAM_IDENTITY_STATUSES)[keyof typeof TELEGRAM_IDENTITY_STATUSES];

export const TELEGRAM_MESSAGE_DIRECTIONS = {
    INBOUND: 'inbound',
    OUTBOUND: 'outbound',
} as const;

export type TelegramMessageDirection =
    (typeof TELEGRAM_MESSAGE_DIRECTIONS)[keyof typeof TELEGRAM_MESSAGE_DIRECTIONS];

export const TELEGRAM_HARNESS_STATUSES = {
    SUCCESS: 'success',
    REQUIERE_ACLARACION: 'requiere_aclaracion',
    NO_RESUELTA: 'no_resuelta',
    ERROR: 'error',
    SYSTEM: 'system',
} as const;

export type TelegramHarnessStatus =
    (typeof TELEGRAM_HARNESS_STATUSES)[keyof typeof TELEGRAM_HARNESS_STATUSES];

export interface TelegramConnectionRecord {
    id: string;
    organization_id: string;
    telegram_bot_id: number;
    bot_username: string;
    bot_first_name: string | null;
    webhook_token: string;
    webhook_registered_at: string | null;
    status: TelegramConnectionStatus;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface TelegramIdentityRecord {
    id: string;
    organization_id: string;
    organization_member_id: string;
    user_id: string;
    telegram_user_id: number;
    telegram_chat_id: number;
    telegram_username: string | null;
    telegram_first_name: string | null;
    status: TelegramIdentityStatus;
    linked_at: string;
    revoked_at: string | null;
    last_seen_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface TelegramLinkTokenRecord {
    id: string;
    organization_id: string;
    organization_member_id: string;
    created_by_user_id: string;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    used_by_telegram_user_id: number | null;
    created_at: string;
}

export interface TelegramConversationTurn {
    question: string;
    intent: NlIntentKey;
    parameters: Record<string, unknown>;
    period?: NlPeriodParam;
    resultDigest: string;
    createdAt: string;
}

export interface TelegramConversationRecord {
    id: string;
    organization_id: string;
    telegram_chat_id: number;
    telegram_identity_id: string | null;
    context: TelegramConversationTurn[];
    context_expires_at: string | null;
    created_at: string;
    updated_at: string;
}

export interface TelegramMessageRecord {
    id: string;
    organization_id: string;
    conversation_id: string | null;
    telegram_identity_id: string | null;
    direction: TelegramMessageDirection;
    telegram_update_id: number | null;
    telegram_message_id: number | null;
    intent: string | null;
    harness_status: TelegramHarnessStatus | null;
    execution_time_ms: number | null;
    error: string | null;
    created_at: string;
}
