import { z } from 'zod';
import {
    NL_INTENT_KEYS,
    NL_INTENT_CATEGORIES,
    NL_RESULT_SHAPES,
    type NlIntentDefinition,
    type IntentExecutionResult,
} from '../../../types/natural-reports.js';
import { getActiveEmailAccount, NO_ACTIVE_MAILBOX_MESSAGE } from '../../email/email-account.service.js';
import { getAccountCredentials } from '../../email/email-account-vault.js';
import { searchInbox, type EmailSearchResultItem } from '../../email/imap-client.js';
import { withToolTimeout, TOOL_READ_TIMEOUT_MS } from '../../../lib/tool-timeout.js';

const MAX_ITEMS = 15;
const LOOKBACK_DAYS = 7;

// Texto en segunda persona (se lee en el dashboard escrito, no lo dice un
// agente de voz) — a propósito distinto de NO_ACTIVE_MAILBOX_MESSAGE
// (primera persona, para routes/tools/email.ts). Ver
// docs/tasks/reportes-nl-correos-backend.md §5.3 para el texto exacto.
const NO_LINKED_MAILBOX_WARNING = 'No tienes ningún buzón de correo vinculado en tu cuenta para consultar correos entrantes.';

export const resumenCorreosRecibidosSchema = z.object({
    soloNoLeidos: z.boolean().optional(),
});
export type ResumenCorreosRecibidosParams = z.infer<typeof resumenCorreosRecibidosSchema>;

export type CorreoRecibidoListItem = EmailSearchResultItem;

/**
 * Única intención con fuente de datos en vivo (IMAP) en vez de Supabase —
 * ver docs/natural-language-reports.md §7 para el porqué de este diseño:
 * sin llamada a LLM propia (el paso de narrativa genérico ya sintetiza el
 * resumen desde `data`), sin buscar cuerpo de mensaje (solo lo que
 * `searchInbox` ya trae del sobre — traer cuerpo de hasta 15 mensajes
 * reventaría el presupuesto de 5s de `executeIntent`).
 */
export const resumenCorreosRecibidosIntent: NlIntentDefinition<ResumenCorreosRecibidosParams, CorreoRecibidoListItem[]> = {
    key: NL_INTENT_KEYS.RESUMEN_CORREOS_RECIBIDOS,
    category: NL_INTENT_CATEGORIES.CORREOS,
    description: 'Correos recientes (últimos 7 días) o no leídos recibidos en el buzón corporativo vinculado, consultados en vivo.',
    examples: [
        '¿Qué correos me llegaron hoy?',
        '¿Tengo correos pendientes de responder?',
        'Correos no leídos en mi buzón',
        '¿Qué me han escrito esta semana?',
    ],
    resultShape: NL_RESULT_SHAPES.LISTA,
    parametersSchema: resumenCorreosRecibidosSchema,
    execute: async (fastify, organizationId, params): Promise<IntentExecutionResult<CorreoRecibidoListItem[]>> => {
        const accountResult = await getActiveEmailAccount(fastify, organizationId);
        if (!accountResult.ok) {
            const warning = accountResult.message === NO_ACTIVE_MAILBOX_MESSAGE ? NO_LINKED_MAILBOX_WARNING : accountResult.message;
            return { shape: NL_RESULT_SHAPES.LISTA, data: [], warnings: [warning] };
        }
        const { account } = accountResult;

        const credentials = await getAccountCredentials(account.vault_secret_id);
        if (!credentials) {
            fastify.log.error(
                { organizationId },
                '[NlIntent:resumen_correos_recibidos] No se pudieron recuperar las credenciales del buzón'
            );
            throw new Error('No se pudieron recuperar las credenciales del buzón para consultar el correo entrante.');
        }

        const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        const results = await withToolTimeout(
            () =>
                searchInbox(
                    { host: account.imap_host, port: account.imap_port, secure: account.imap_secure, user: account.imap_username, pass: credentials.imapPassword },
                    { since, limit: MAX_ITEMS, unseenOnly: params.soloNoLeidos }
                ),
            TOOL_READ_TIMEOUT_MS
        );

        const warnings: string[] = [];
        if (results.length === 0) {
            warnings.push(
                params.soloNoLeidos
                    ? 'No tienes correos sin leer en los últimos 7 días.'
                    : 'No se encontraron correos recibidos en los últimos 7 días.'
            );
        }

        return {
            shape: NL_RESULT_SHAPES.LISTA,
            data: results,
            warnings,
            summaryMetrics: { totalMostrado: results.length },
        };
    },
};
