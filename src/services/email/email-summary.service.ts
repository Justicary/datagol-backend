import { FastifyInstance } from 'fastify';
import { supabaseAdmin } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';
import { getActiveEmailAccount, NO_ACTIVE_MAILBOX_MESSAGE } from './email-account.service.js';
import { getAccountCredentials } from './email-account-vault.js';
import { getInboxSnapshot, ImapConnectionError } from './imap-client.js';
import { withToolTimeout, ToolTimeoutError } from '../../lib/tool-timeout.js';
import { EmailInboxSummaryResponse, EmailInboxSummaryTask } from '../../schemas/email-summary.js';

/**
 * Resumen consolidado de correo para el dashboard admin
 * (docs/tasks/email-inbox-summary-backend.md): no leídos (IMAP en vivo),
 * borradores/errores/enviados (`email_outbox`), combinados en una sola
 * lista de tareas priorizada. Nunca lanza por un fallo de proveedor — cada
 * rama degrada a datos parciales, igual que `routes/tools/email.ts`.
 */

// 5s: presupuesto propio del endpoint (docs/tasks/email-inbox-summary-backend.md
// §"Consultar el Servidor IMAP"). No es el camino crítico de voz de AGENTS.md
// §3 (esto es un GET de dashboard, no un tool call en vivo), por eso no
// reutiliza TOOL_READ_TIMEOUT_MS/TOOL_MUTATION_TIMEOUT_MS de tool-timeout.ts.
const INBOX_SUMMARY_IMAP_TIMEOUT_MS = 5000;

// Tope de la lista de no leídos por especificación (doc, paso 3: "últimos 5
// correos no leídos"). Se aplica el mismo tope a borradores/errores para
// acotar el tamaño de la respuesta — el doc no especifica un límite para
// esas dos categorías.
const TASK_LIST_LIMIT = 5;

const SUMMARY_CACHE_TTL_MS = 60 * 1000;

interface SummaryCacheItem {
    value: EmailInboxSummaryResponse;
    expiresAt: number;
}

const summaryCache = new Map<string, SummaryCacheItem>();

interface OutboxDraftRow {
    id: string;
    to_addresses: string[] | null;
    subject: string;
    body_text: string;
    created_at: string;
}

interface OutboxFailedRow {
    id: string;
    to_addresses: string[] | null;
    subject: string;
    created_at: string;
    error_message: string | null;
}

export async function getInboxSummary(
    fastify: FastifyInstance,
    organizationId: string
): Promise<EmailInboxSummaryResponse> {
    const now = Date.now();
    const cached = summaryCache.get(organizationId);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const [draftCount, failedCount, sentCount, draftRows, failedRows] = await Promise.all([
        countOutbox(organizationId, 'draft'),
        countOutbox(organizationId, 'failed'),
        countOutbox(organizationId, 'sent'),
        fetchDraftRows(organizationId),
        fetchFailedRows(organizationId),
    ]);

    const draftTasks: EmailInboxSummaryTask[] = draftRows.map((row) => ({
        id: `draft-${row.id}`,
        to: row.to_addresses?.join(', ') ?? null,
        subject: row.subject,
        date: row.created_at,
        snippet: row.body_text.slice(0, 120),
        unread: false,
        category: 'draft' as const,
    }));

    const outboxErrorTasks: EmailInboxSummaryTask[] = failedRows.map((row) => ({
        id: `error-${row.id}`,
        to: row.to_addresses?.join(', ') ?? null,
        subject: row.subject,
        date: row.created_at,
        snippet: (row.error_message ?? row.subject).slice(0, 120),
        unread: false,
        category: 'error' as const,
    }));

    const { unreadCount, totalMessages, lastSyncedAt, unreadTasks, brokenAccountTask } =
        await resolveMailboxState(fastify, organizationId);

    const errorTasks = brokenAccountTask ? [brokenAccountTask, ...outboxErrorTasks] : outboxErrorTasks;
    const errorsCount = failedCount + (brokenAccountTask ? 1 : 0);

    const response: EmailInboxSummaryResponse = {
        unreadCount,
        draftsCount: draftCount,
        errorsCount,
        sentCount,
        totalMessages,
        lastSyncedAt,
        stats: {
            unreadCount,
            draftsCount: draftCount,
            errorsCount,
            sentCount,
        },
        messages: [...unreadTasks, ...draftTasks, ...errorTasks],
    };

    summaryCache.set(organizationId, { value: response, expiresAt: now + SUMMARY_CACHE_TTL_MS });
    return response;
}

/**
 * Resuelve el estado en vivo del buzón: sin cuenta activa, cuenta activa con
 * IMAP consultado (o degradado ante fallo), o cuenta rota (`status='error'`)
 * detectada aparte porque `getActiveEmailAccount` solo mira cuentas activas
 * (docs/tasks/email-inbox-summary-backend.md, paso 4: "errorsCount ... + 1 si
 * email_accounts.status === 'error'").
 */
async function resolveMailboxState(
    fastify: FastifyInstance,
    organizationId: string
): Promise<{
    unreadCount: number;
    totalMessages: number;
    lastSyncedAt: string | null;
    unreadTasks: EmailInboxSummaryTask[];
    brokenAccountTask: EmailInboxSummaryTask | null;
}> {
    const empty = { unreadCount: 0, totalMessages: 0, lastSyncedAt: null, unreadTasks: [] as EmailInboxSummaryTask[] };

    const accountResult = await getActiveEmailAccount(fastify, organizationId);
    if (!accountResult.ok) {
        const brokenAccountTask =
            accountResult.message === NO_ACTIVE_MAILBOX_MESSAGE ? await findBrokenAccountTask(organizationId) : null;
        return { ...empty, brokenAccountTask };
    }

    const { account } = accountResult;
    const credentials = await getAccountCredentials(account.vault_secret_id);
    if (!credentials) {
        logger.error(
            { organizationId, msg: 'Resumen de correo degradado: no se pudieron recuperar credenciales IMAP' }
        );
        return { ...empty, brokenAccountTask: null };
    }

    try {
        const snapshot = await withToolTimeout(
            () =>
                getInboxSnapshot(
                    {
                        host: account.imap_host,
                        port: account.imap_port,
                        secure: account.imap_secure,
                        user: account.imap_username,
                        pass: credentials.imapPassword,
                    },
                    TASK_LIST_LIMIT
                ),
            INBOX_SUMMARY_IMAP_TIMEOUT_MS
        );

        const unreadTasks: EmailInboxSummaryTask[] = snapshot.unreadItems.map((item) => ({
            id: `msg-${item.uid}`,
            uid: item.uid,
            from: item.from,
            fromName: item.fromName,
            subject: item.subject,
            date: item.date,
            snippet: item.snippet,
            unread: true,
            category: 'unread' as const,
        }));

        return {
            unreadCount: snapshot.unreadCount,
            totalMessages: snapshot.totalMessages,
            lastSyncedAt: new Date().toISOString(),
            unreadTasks,
            brokenAccountTask: null,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = err instanceof ToolTimeoutError;
        const isConnectionError = err instanceof ImapConnectionError;
        logger.warn(
            { organizationId, err, msg, isTimeout, isConnectionError },
            '[EmailSummaryService] Resumen degradado: fallo consultando IMAP'
        );

        // Best-effort: no aborta la respuesta si esta actualización falla.
        const { error: updateErr } = await supabaseAdmin
            .from('email_accounts')
            .update({ last_error: msg })
            .eq('id', account.id);
        if (updateErr) {
            logger.warn({ err: updateErr, organizationId, accountId: account.id }, '[EmailSummaryService] No se pudo registrar last_error');
        }

        return { ...empty, brokenAccountTask: null };
    }
}

async function findBrokenAccountTask(organizationId: string): Promise<EmailInboxSummaryTask | null> {
    const { data } = await supabaseAdmin
        .from('email_accounts')
        .select('id, last_error')
        .eq('organization_id', organizationId)
        .eq('status', 'error')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

    if (!data) {
        return null;
    }

    return {
        id: `account-error-${data.id}`,
        subject: 'Buzón desconectado',
        date: null,
        snippet: (data.last_error ?? 'El buzón no pudo validarse; revisa sus credenciales.').slice(0, 120),
        unread: false,
        category: 'error',
    };
}

async function countOutbox(organizationId: string, status: 'draft' | 'failed' | 'sent'): Promise<number> {
    const { count, error } = await supabaseAdmin
        .from('email_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId)
        .eq('status', status);

    if (error) {
        throw new Error(`Error contando email_outbox (status=${status}): ${error.message}`);
    }
    return count ?? 0;
}

async function fetchDraftRows(organizationId: string): Promise<OutboxDraftRow[]> {
    const { data, error } = await supabaseAdmin
        .from('email_outbox')
        .select('id, to_addresses, subject, body_text, created_at')
        .eq('organization_id', organizationId)
        .eq('status', 'draft')
        .order('created_at', { ascending: true })
        .limit(TASK_LIST_LIMIT);

    if (error) {
        throw new Error(`Error listando borradores de email_outbox: ${error.message}`);
    }
    return (data as OutboxDraftRow[] | null) ?? [];
}

async function fetchFailedRows(organizationId: string): Promise<OutboxFailedRow[]> {
    const { data, error } = await supabaseAdmin
        .from('email_outbox')
        .select('id, to_addresses, subject, created_at, error_message')
        .eq('organization_id', organizationId)
        .eq('status', 'failed')
        .order('created_at', { ascending: true })
        .limit(TASK_LIST_LIMIT);

    if (error) {
        throw new Error(`Error listando fallos de email_outbox: ${error.message}`);
    }
    return (data as OutboxFailedRow[] | null) ?? [];
}

/** Expuesto para pruebas — invalida el snapshot cacheado de una organización. */
export function clearInboxSummaryCache(organizationId?: string): void {
    if (!organizationId) {
        summaryCache.clear();
        return;
    }
    summaryCache.delete(organizationId);
}
