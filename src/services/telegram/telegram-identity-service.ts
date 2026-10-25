import crypto from 'crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { hashToken } from '../../lib/token-hash.js';
import { checkAndRecordHit } from '../../lib/rate-limiter.js';
import { isFeatureEnabled } from '../entitlements.js';
import { getPermissionsForMember } from '../permission-service.js';
import { FEATURE_KEYS } from '../../types/feature-taxonomy.js';
import { PERMISSION_KEYS } from '../../types/permission-keys.js';
import type { TelegramIdentityRecord } from '../../types/telegram.js';
import { TELEGRAM_USER_MESSAGES } from './formatter.js';

const LINK_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutos
const START_ATTEMPTS_LIMIT = 5;
const START_ATTEMPTS_WINDOW_MS = 60 * 1000; // 1 minuto

const ALLOWED_TELEGRAM_ROLES = new Set(['owner', 'admin']);

export class TelegramIdentityError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number = 400) {
        super(message);
        this.name = 'TelegramIdentityError';
        this.statusCode = statusCode;
    }
}

export interface CreateLinkTokenResult {
    deepLink: string;
    botUsername: string;
    expiresAt: string;
}

/**
 * Genera un token efímero de un solo uso para vincular la cuenta de Telegram
 * del administrador autenticado (`userId`) con su membresía en `organizationId`.
 * El token en claro solo viaja en `deepLink`; en Postgres se persiste `SHA-256`.
 */
export async function createTelegramLinkToken(
    organizationId: string,
    userId: string
): Promise<CreateLinkTokenResult> {
    // 1. Verificar que exista conexión activa del bot en la organización
    const { data: conn } = await supabaseAdmin
        .from('telegram_connections')
        .select('bot_username, status')
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (!conn || conn.status !== 'active' || !conn.bot_username) {
        throw new TelegramIdentityError(
            'La organización no tiene un Bot de Telegram activo configurado.',
            400
        );
    }

    // 2. Verificar que el usuario sea miembro owner/admin de la organización
    const { data: member } = await supabaseAdmin
        .from('organization_members')
        .select('id, role')
        .eq('organization_id', organizationId)
        .eq('user_id', userId)
        .maybeSingle();

    if (!member || !ALLOWED_TELEGRAM_ROLES.has(member.role as string)) {
        throw new TelegramIdentityError(
            'Solo los miembros con rol owner o admin pueden vincular su cuenta al Bot de Telegram.',
            403
        );
    }

    // 3. Verificar que tenga el permiso use_nl_reports activo
    const permissions = await getPermissionsForMember(organizationId, userId);
    if (!permissions.has(PERMISSION_KEYS.USE_NL_REPORTS)) {
        throw new TelegramIdentityError(
            'Tu cuenta no tiene habilitado el permiso para consultar reportes en lenguaje natural (use_nl_reports).',
            403
        );
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();

    const { error } = await supabaseAdmin.from('telegram_link_tokens').insert({
        organization_id: organizationId,
        organization_member_id: member.id,
        created_by_user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt,
    });

    if (error) {
        throw new TelegramIdentityError('No se pudo generar el token de vinculación.', 500);
    }

    const botUsername = conn.bot_username as string;
    return {
        deepLink: `https://t.me/${botUsername}?start=${rawToken}`,
        botUsername,
        expiresAt,
    };
}

export interface RedeemStartTokenParams {
    organizationId: string;
    rawToken: string;
    telegramUserId: number;
    telegramChatId: number;
    telegramUsername?: string;
    telegramFirstName?: string;
}

export interface RedeemStartTokenResult {
    ok: boolean;
    message: string;
    identityId?: string;
}

/**
 * Canjea un token `/start <token>` recibido desde un chat privado de Telegram.
 * Cualquier fallo (token inexistente, de otra organización, ya usado, expirado
 * o miembro degradado) devuelve el mismo mensaje genérico `LINK_INVALID`
 * para impedir ataques de enumeración.
 */
export async function redeemTelegramStartToken(
    params: RedeemStartTokenParams
): Promise<RedeemStartTokenResult> {
    const rateCheck = checkAndRecordHit(
        `tg_start_user:${params.telegramUserId}`,
        START_ATTEMPTS_LIMIT,
        START_ATTEMPTS_WINDOW_MS
    );
    if (!rateCheck.ok) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_RATE_LIMITED,
        };
    }

    const trimmedToken = params.rawToken.trim();
    if (!trimmedToken || trimmedToken.length < 16) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    const tokenHash = hashToken(trimmedToken);
    const nowIso = new Date().toISOString();

    // 1. Buscar el token perteneciente a ESTA organización
    const { data: linkToken } = await supabaseAdmin
        .from('telegram_link_tokens')
        .select('id, organization_id, organization_member_id, expires_at, used_at')
        .eq('token_hash', tokenHash)
        .eq('organization_id', params.organizationId)
        .maybeSingle();

    if (!linkToken || linkToken.used_at !== null || new Date(linkToken.expires_at).getTime() <= Date.now()) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    // 2. Re-verificar en el momento del canje que el miembro siga siendo owner/admin con use_nl_reports
    const { data: member } = await supabaseAdmin
        .from('organization_members')
        .select('id, user_id, role')
        .eq('id', linkToken.organization_member_id)
        .eq('organization_id', params.organizationId)
        .maybeSingle();

    if (!member || !ALLOWED_TELEGRAM_ROLES.has(member.role as string)) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    const permissions = await getPermissionsForMember(params.organizationId, member.user_id as string);
    if (!permissions.has(PERMISSION_KEYS.USE_NL_REPORTS)) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    // 3. Verificar que este telegram_user_id no esté vinculado a OTRA organización (UNIQUE global en v1)
    const { data: existingIdentityByTgUser } = await supabaseAdmin
        .from('telegram_identities')
        .select('id, organization_id, organization_member_id')
        .eq('telegram_user_id', params.telegramUserId)
        .maybeSingle();

    if (
        existingIdentityByTgUser &&
        (existingIdentityByTgUser.organization_id !== params.organizationId ||
            existingIdentityByTgUser.organization_member_id !== member.id)
    ) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    // 4. Sellar el token de forma atómica (used_at IS NULL)
    const { data: claimedToken, error: claimErr } = await supabaseAdmin
        .from('telegram_link_tokens')
        .update({
            used_at: nowIso,
            used_by_telegram_user_id: params.telegramUserId,
        })
        .eq('id', linkToken.id)
        .is('used_at', null)
        .select('id')
        .maybeSingle();

    if (claimErr || !claimedToken) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    // 5. Crear o reactivar la identidad en telegram_identities
    const { data: identity, error: identityErr } = await supabaseAdmin
        .from('telegram_identities')
        .upsert(
            {
                organization_id: params.organizationId,
                organization_member_id: member.id,
                user_id: member.user_id,
                telegram_user_id: params.telegramUserId,
                telegram_chat_id: params.telegramChatId,
                telegram_username: params.telegramUsername ?? null,
                telegram_first_name: params.telegramFirstName ?? null,
                status: 'active',
                linked_at: nowIso,
                revoked_at: null,
                last_seen_at: nowIso,
            },
            { onConflict: 'organization_id,organization_member_id' }
        )
        .select('id')
        .single();

    if (identityErr || !identity) {
        return {
            ok: false,
            message: TELEGRAM_USER_MESSAGES.LINK_INVALID,
        };
    }

    return {
        ok: true,
        message: TELEGRAM_USER_MESSAGES.LINK_SUCCESS,
        identityId: identity.id as string,
    };
}

export type AuthorizeTelegramSenderResult =
    | {
          ok: true;
          identity: TelegramIdentityRecord;
          memberRole: 'owner' | 'admin';
      }
    | {
          ok: false;
          reason:
              | 'identity_not_found'
              | 'identity_revoked'
              | 'org_suspended'
              | 'feature_disabled'
              | 'role_not_allowed'
              | 'permission_denied';
          userMessage: string;
      };

/**
 * Re-evalúa en tiempo real la cadena completa de autorización en cada mensaje
 * entrante de Telegram dentro del worker de pg-boss:
 *   telegram_user_id -> telegram_identities (active) -> organization_members (owner|admin)
 *   -> organizations (status != suspended) -> feature 'telegram' + 'natural_language_reports'
 *   -> permiso 'use_nl_reports'.
 *
 * Un usuario sin identidad activa o con identidad revocada recibe exactamente
 * el mismo mensaje (`UNAUTHORIZED`) para no confirmar la existencia de la organización.
 */
export async function authorizeTelegramMessageSender(
    organizationId: string,
    telegramUserId: number
): Promise<AuthorizeTelegramSenderResult> {
    // 1. Buscar identidad por (organization_id, telegram_user_id)
    const { data: identityRow } = await supabaseAdmin
        .from('telegram_identities')
        .select('*')
        .eq('organization_id', organizationId)
        .eq('telegram_user_id', telegramUserId)
        .maybeSingle();

    if (!identityRow) {
        return {
            ok: false,
            reason: 'identity_not_found',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    const identity = identityRow as TelegramIdentityRecord;
    if (identity.status !== 'active') {
        return {
            ok: false,
            reason: 'identity_revoked',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    // 2. Verificar estado de la organización
    const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('status')
        .eq('id', organizationId)
        .maybeSingle();

    if (!org || org.status === 'suspended') {
        return {
            ok: false,
            reason: 'org_suspended',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    // 3. Verificar entitlements ('telegram' y 'natural_language_reports')
    const [telegramEnabled, nlReportsEnabled] = await Promise.all([
        isFeatureEnabled(organizationId, FEATURE_KEYS.TELEGRAM),
        isFeatureEnabled(organizationId, FEATURE_KEYS.NATURAL_LANGUAGE_REPORTS),
    ]);

    if (!telegramEnabled || !nlReportsEnabled) {
        return {
            ok: false,
            reason: 'feature_disabled',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    // 4. Re-verificar rol actual del miembro en organization_members
    const { data: member } = await supabaseAdmin
        .from('organization_members')
        .select('id, user_id, role')
        .eq('id', identity.organization_member_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

    if (!member || !ALLOWED_TELEGRAM_ROLES.has(member.role as string)) {
        return {
            ok: false,
            reason: 'role_not_allowed',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    // 5. Re-verificar permiso RBAC 'use_nl_reports'
    const permissions = await getPermissionsForMember(organizationId, identity.user_id);
    if (!permissions.has(PERMISSION_KEYS.USE_NL_REPORTS)) {
        return {
            ok: false,
            reason: 'permission_denied',
            userMessage: TELEGRAM_USER_MESSAGES.UNAUTHORIZED,
        };
    }

    return {
        ok: true,
        identity,
        memberRole: member.role as 'owner' | 'admin',
    };
}

/**
 * Lista las identidades de Telegram vinculadas a la organización.
 */
export async function listTelegramIdentities(organizationId: string): Promise<TelegramIdentityRecord[]> {
    const { data, error } = await supabaseAdmin
        .from('telegram_identities')
        .select('*')
        .eq('organization_id', organizationId)
        .order('linked_at', { ascending: false });

    if (error || !data) {
        return [];
    }
    return data as TelegramIdentityRecord[];
}

/**
 * Revoca una identidad de Telegram vinculada a la organización e invalida su
 * contexto conversacional activo.
 */
export async function revokeTelegramIdentity(
    organizationId: string,
    identityId: string
): Promise<boolean> {
    const { data: updated, error } = await supabaseAdmin
        .from('telegram_identities')
        .update({
            status: 'revoked',
            revoked_at: new Date().toISOString(),
        })
        .eq('id', identityId)
        .eq('organization_id', organizationId)
        .select('id, telegram_chat_id')
        .maybeSingle();

    if (error || !updated) {
        return false;
    }

    await supabaseAdmin
        .from('telegram_conversations')
        .delete()
        .eq('organization_id', organizationId)
        .eq('telegram_chat_id', updated.telegram_chat_id);

    return true;
}
