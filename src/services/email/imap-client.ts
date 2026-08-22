import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { logger } from '../../lib/logger.js';

/**
 * Wrapper delgado sobre `imapflow` — conexión efímera por llamada (task doc
 * §2.2/2.3), sin pool ni reutilización de sockets entre tool calls. El
 * timeout duro del camino crítico lo aplica el llamador con
 * `withToolTimeout()` (src/lib/tool-timeout.ts); aquí solo se limita el
 * socket subyacente para que una conexión colgada no sobreviva a esa
 * cancelación como proceso huérfano.
 */

const SOCKET_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 20_000; // AGENTS.md tarea §2.3: "sin saturar memoria"
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

export interface ImapConnectionConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
}

export class ImapConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ImapConnectionError';
    }
}

function buildClient(config: ImapConnectionConfig): ImapFlow {
    return new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        logger: false,
        socketTimeout: SOCKET_TIMEOUT_MS,
    });
}

/**
 * Abre y cierra una conexión IMAP real — usado por
 * `email-account.service.ts` antes de persistir una cuenta nueva.
 */
export async function verifyImapConnection(config: ImapConnectionConfig): Promise<void> {
    const client = buildClient(config);
    try {
        await client.connect();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ImapConnectionError(`No se pudo conectar al servidor IMAP: ${msg}`);
    } finally {
        try {
            await client.logout();
        } catch {
            // La conexión pudo no haberse establecido; nada que cerrar.
        }
    }
}

export interface EmailSearchFilters {
    subject?: string;
    from?: string;
    since?: Date;
    before?: Date;
    limit?: number;
    // No confundir con `status` de email_outbox (envío saliente) — este es
    // el flag \Seen de IMAP sobre mensajes recibidos. imapflow lo expone
    // como `seen: false` dentro del objeto de búsqueda.
    unseenOnly?: boolean;
}

export interface EmailSearchResultItem {
    uid: number;
    from: string | null;
    subject: string | null;
    date: string | null;
    snippet: string;
}

/**
 * Busca correos en INBOX. Sin filtros explícitos, devuelve los más
 * recientes (UIDs son monótonos crecientes — SINCE época 0 + cola del
 * arreglo evita tener que calcular números de secuencia por servidor).
 */
export async function searchInbox(
    config: ImapConnectionConfig,
    filters: EmailSearchFilters
): Promise<EmailSearchResultItem[]> {
    const limit = Math.min(filters.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const client = buildClient(config);

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const query: Record<string, unknown> = {};
            if (filters.subject) query.subject = filters.subject;
            if (filters.from) query.from = filters.from;
            if (filters.since) query.since = filters.since;
            if (filters.before) query.before = filters.before;
            if (filters.unseenOnly) query.seen = false;
            if (Object.keys(query).length === 0) query.since = new Date(0);

            const uids = (await client.search(query, { uid: true })) as number[] | false;
            if (!uids || uids.length === 0) {
                return [];
            }

            const targetUids = uids.slice(-limit).reverse();
            const results: EmailSearchResultItem[] = [];

            for await (const msg of client.fetch(targetUids, { envelope: true }, { uid: true })) {
                const from = msg.envelope?.from?.[0];
                results.push({
                    uid: msg.uid,
                    from: from ? (from.address ?? from.name ?? null) : null,
                    subject: msg.envelope?.subject ?? null,
                    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
                    snippet: (msg.envelope?.subject ?? '').slice(0, 140),
                });
            }

            // client.fetch no garantiza el orden de targetUids; se reordena
            // por UID descendente (más reciente primero) explícitamente.
            results.sort((a, b) => b.uid - a.uid);
            return results;
        } finally {
            lock.release();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ImapConnectionError(`Error buscando correos: ${msg}`);
    } finally {
        try {
            await client.logout();
        } catch {
            // Nada que cerrar si nunca llegó a conectar.
        }
    }
}

export interface EmailMessageDetail {
    uid: number;
    from: string | null;
    to: string[];
    subject: string | null;
    date: string | null;
    messageId: string | null;
    inReplyTo: string | null;
    bodyText: string;
    truncated: boolean;
}

/**
 * Descarga y limpia el cuerpo de un correo (texto plano; si el mensaje solo
 * trae HTML, se convierte a texto) truncado a `MAX_BODY_CHARS` para que el
 * servicio LLM pueda resumirlo sin saturar memoria (task doc §2.3).
 */
export async function getMessageDetail(
    config: ImapConnectionConfig,
    uid: number
): Promise<EmailMessageDetail | null> {
    const client = buildClient(config);

    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
            if (!msg || !msg.source) {
                return null;
            }

            const parsed = await simpleParser(msg.source);
            const rawText = parsed.text?.trim()
                ? parsed.text
                : parsed.html
                    ? htmlToText(parsed.html, { wordwrap: false })
                    : '';

            const truncated = rawText.length > MAX_BODY_CHARS;
            const bodyText = truncated ? `${rawText.slice(0, MAX_BODY_CHARS)}\n[... truncado ...]` : rawText;

            return {
                uid,
                from: msg.envelope?.from?.[0]?.address ?? null,
                to: (msg.envelope?.to ?? []).map((addr) => addr.address).filter((a): a is string => !!a),
                subject: msg.envelope?.subject ?? null,
                date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
                messageId: parsed.messageId ?? null,
                inReplyTo: parsed.inReplyTo ?? null,
                bodyText,
                truncated,
            };
        } finally {
            lock.release();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err, uid, msg }, '[ImapClient] Error obteniendo detalle del mensaje');
        throw new ImapConnectionError(`Error obteniendo el correo: ${msg}`);
    } finally {
        try {
            await client.logout();
        } catch {
            // Nada que cerrar si nunca llegó a conectar.
        }
    }
}
