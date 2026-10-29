import { describe, it, expect } from 'vitest';
import {
    formatHarnessResponseForTelegram,
    splitTelegramHtmlMessage,
    buildResultDigest,
    isTelegramHelpQuery,
    TELEGRAM_MAX_MESSAGE_LENGTH,
    MAX_RESULT_DIGEST_LENGTH,
    TELEGRAM_USER_MESSAGES,
} from '../src/services/telegram/formatter.js';
import type { AskReportResponse, AskReportSuccessResponse } from '../src/types/natural-reports.js';

describe('Telegram Formatter (formatter.ts)', () => {
    it('debe tener los mensajes estándar de usuario definidos y no vacíos', () => {
        expect(TELEGRAM_USER_MESSAGES.UNAUTHORIZED).toContain('No tienes una cuenta vinculada');
        expect(TELEGRAM_USER_MESSAGES.LINK_SUCCESS).toContain('Cuenta vinculada correctamente');
        expect(TELEGRAM_USER_MESSAGES.LINK_INVALID).toContain('no es válido');
        expect(TELEGRAM_USER_MESSAGES.LINK_RATE_LIMITED).toContain('demasiados intentos');
        expect(TELEGRAM_USER_MESSAGES.HELP).toContain('/nuevo');
        expect(TELEGRAM_USER_MESSAGES.CONTEXT_CLEARED).toContain('Contexto de conversación reiniciado');
        expect(TELEGRAM_USER_MESSAGES.EMPTY_QUESTION).toContain('pregunta en texto');
        expect(TELEGRAM_USER_MESSAGES.EXECUTION_ERROR).toContain('No fue posible procesar');
    });

    it('debe formatear respuesta requiere_aclaracion escapando HTML malicioso (prevención XSS)', () => {
        const res: AskReportResponse = {
            status: 'requiere_aclaracion',
            preguntaAclaracion: '¿Te refieres a <script>alert("xss")</script> o a "este mes" & \'hoy\'?',
        };

        const html = formatHarnessResponseForTelegram(res);
        expect(html).toContain('🤔 <b>Necesito una aclaración</b>');
        expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        expect(html).toContain('&amp; &#039;hoy&#039;');
        expect(html).not.toContain('<script>');
    });

    it('debe formatear respuesta no_resuelta escapando HTML malicioso', () => {
        const res: AskReportResponse = {
            status: 'no_resuelta',
            reason: 'No tenemos <img src=x onerror=alert(1)> en el catálogo.',
        };

        const html = formatHarnessResponseForTelegram(res);
        expect(html).toContain('ℹ️ <b>Consulta fuera del catálogo actual</b>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img');
    });

    it('debe formatear respuesta ok con shape="numero", sub-objetos, narrativa y warnings escapados', () => {
        const res: AskReportSuccessResponse = {
            status: 'ok',
            intent: 'costo_total_periodo',
            shape: 'numero',
            period: {
                from: '2026-10-01T00:00:00Z',
                to: '2026-10-25T23:59:59Z',
                label: 'este mes <octubre>',
            },
            interpretation: 'Costo total del mes & desglose',
            narrative: 'El gasto total fue de $125.50 USD <verificado>.',
            data: {
                totalUsd: 125.5,
                totalLlamadas: 42,
                activo: true,
                inactivo: false,
                vacio: null,
                desglosePorProveedor: {
                    elevenLabs: 80.25,
                    openRouter: 45.25,
                },
            },
            warnings: ['Tarifa <estimada> para llamadas salientes'],
        };

        const html = formatHarnessResponseForTelegram(res);
        expect(html).toContain('📊 <b>Costo total del mes &amp; desglose</b>');
        expect(html).toContain('🗓 <i>Periodo: este mes &lt;octubre&gt;</i>');
        expect(html).toContain('El gasto total fue de $125.50 USD &lt;verificado&gt;.');
        expect(html).toContain('• <b>Total Usd:</b> <code>125.50</code>');
        expect(html).toContain('• <b>Total Llamadas:</b> <code>42</code>');
        expect(html).toContain('• <b>Activo:</b> <code>Sí</code>');
        expect(html).toContain('• <b>Inactivo:</b> <code>No</code>');
        expect(html).toContain('• <b>Vacio:</b> <code>—</code>');
        expect(html).toContain('• <b>Desglose Por Proveedor:</b> Eleven Labs: 80.25, Open Router: 45.25');
        expect(html).toContain('⚠️ <i>Tarifa &lt;estimada&gt; para llamadas salientes</i>');
    });

    it('debe formatear shape="numero" vacío y data nula adecuadamente', () => {
        const emptyObjRes: AskReportSuccessResponse = {
            status: 'ok',
            intent: 'costo_total_periodo',
            shape: 'numero',
            period: { from: '2026-10-01', to: '2026-10-02', label: 'hoy' },
            interpretation: 'Costo hoy',
            narrative: null,
            data: {},
            warnings: [],
        };
        expect(formatHarnessResponseForTelegram(emptyObjRes)).toContain('<i>Sin datos registrados.</i>');

        const nullDataRes: AskReportSuccessResponse = {
            ...emptyObjRes,
            data: null,
        };
        expect(formatHarnessResponseForTelegram(nullDataRes)).toContain('<i>Sin datos para este periodo.</i>');
    });

    it('debe formatear shape="lista" y shape="tabla" con arreglos directos, .items, .rows y listas vacías', () => {
        const listRes: AskReportSuccessResponse = {
            status: 'ok',
            intent: 'prospectos_calientes',
            shape: 'lista',
            period: { from: '2026-10-01', to: '2026-10-25', label: 'este mes' },
            interpretation: 'Prospectos calientes',
            narrative: null,
            data: [
                { full_name: 'Juan <Pérez>', phone: '+525512345678', empty_field: '' },
                'Elemento escalar',
            ],
            warnings: [],
        };

        const html = formatHarnessResponseForTelegram(listRes);
        expect(html).toContain('1. <b>Full name:</b> Juan &lt;Pérez&gt; | <b>Phone:</b> +525512345678');
        expect(html).not.toContain('Empty field');
        expect(html).toContain('2. Elemento escalar');

        const itemsRes: AskReportSuccessResponse = {
            ...listRes,
            shape: 'tabla',
            data: {
                items: [{ canal: 'voz', total: 15 }],
            },
        };
        expect(formatHarnessResponseForTelegram(itemsRes)).toContain('1. <b>Canal:</b> voz | <b>Total:</b> 15');

        const rowsRes: AskReportSuccessResponse = {
            ...listRes,
            shape: 'tabla',
            data: {
                rows: [{ motivo: 'precio', conteo: 4 }],
            },
        };
        expect(formatHarnessResponseForTelegram(rowsRes)).toContain('1. <b>Motivo:</b> precio | <b>Conteo:</b> 4');

        const emptyArrayRes: AskReportSuccessResponse = {
            ...listRes,
            data: [],
        };
        expect(formatHarnessResponseForTelegram(emptyArrayRes)).toContain(
            '<i>No se encontraron registros en el periodo consultado.</i>'
        );

        const nonArrayTableObjRes: AskReportSuccessResponse = {
            ...listRes,
            shape: 'tabla',
            data: { resumen: 'sin filas', extra: { a: 1 } },
        };
        expect(formatHarnessResponseForTelegram(nonArrayTableObjRes)).toContain(
            '• <b>Resumen:</b> sin filas'
        );
    });

    it('splitTelegramHtmlMessage debe conservar mensajes cortos en 1 fragmento y dividir mensajes largos sin romper etiquetas HTML', () => {
        const shortMsg = '📊 <b>Reporte corto</b>\nTodo en orden.';
        expect(splitTelegramHtmlMessage(shortMsg)).toEqual([shortMsg]);

        // Crear un mensaje multilínea que supere 4096 caracteres
        const lines = Array.from(
            { length: 120 },
            (_, i) => `${i + 1}. <b>Contacto ${i + 1}:</b> Seguimiento pendiente en la agenda de ventas.`
        );
        const longHtml = lines.join('\n');
        expect(longHtml.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE_LENGTH);

        const chunks = splitTelegramHtmlMessage(longHtml, TELEGRAM_MAX_MESSAGE_LENGTH);
        expect(chunks.length).toBeGreaterThan(1);
        for (let i = 0; i < chunks.length; i++) {
            expect(chunks[i].length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
            expect(chunks[i]).toContain(`<b>(${i + 1}/${chunks.length})</b>`);
        }

        // Probar línea individual muy larga con etiquetas HTML en el borde del corte
        const singleLongLine = Array.from({ length: 30 }, () => '<b>etiqueta_importante</b>').join(' ');
        const smallChunks = splitTelegramHtmlMessage(singleLongLine, 120);
        expect(smallChunks.length).toBeGreaterThan(1);
        for (const chunk of smallChunks) {
            // Verificar que ningún fragmento haya quedado con un '<' sin su '>'
            const openBrackets = (chunk.match(/</g) || []).length;
            const closeBrackets = (chunk.match(/>/g) || []).length;
            expect(openBrackets).toBe(closeBrackets);
        }
    });

    it('buildResultDigest debe acotar el resumen a <= 500 caracteres con y sin narrativa', () => {
        const baseRes: AskReportSuccessResponse = {
            status: 'ok',
            intent: 'citas_hoy',
            shape: 'lista',
            period: { from: '2026-10-25', to: '2026-10-25', label: 'hoy' },
            interpretation: 'Citas programadas para hoy',
            narrative: null,
            data: [],
            warnings: [],
        };

        const withoutNarrative = buildResultDigest(baseRes);
        expect(withoutNarrative).toBe('Citas programadas para hoy (hoy) — shape=lista');
        expect(withoutNarrative.length).toBeLessThanOrEqual(MAX_RESULT_DIGEST_LENGTH);

        const longNarrativeRes: AskReportSuccessResponse = {
            ...baseRes,
            narrative: 'A'.repeat(650),
        };
        const truncatedDigest = buildResultDigest(longNarrativeRes);
        expect(truncatedDigest.length).toBe(MAX_RESULT_DIGEST_LENGTH);
        expect(truncatedDigest.endsWith('...')).toBe(true);
    });

    it('isTelegramHelpQuery debe detectar comandos de ayuda y preguntas sobre capacidades sin falsos positivos en consultas de negocio', () => {
        expect(isTelegramHelpQuery('/start')).toBe(true);
        expect(isTelegramHelpQuery('/ayuda')).toBe(true);
        expect(isTelegramHelpQuery('/help')).toBe(true);
        expect(isTelegramHelpQuery('Que tipo de preguntas te puedo hacer o puedes contestar?')).toBe(true);
        expect(isTelegramHelpQuery('¿Qué preguntas puedo hacer?')).toBe(true);
        expect(isTelegramHelpQuery('¿En qué me puedes ayudar?')).toBe(true);

        expect(isTelegramHelpQuery('¿Tenemos correos electronicos pendientes?')).toBe(false);
        expect(isTelegramHelpQuery('¿Cuántas citas tuvimos hoy?')).toBe(false);
    });

    it('formatea marcas de tiempo ISO a la zona horaria del negocio (22:00 UTC -> 16:00 en America/Mexico_City)', () => {
        const res: AskReportSuccessResponse = {
            status: 'ok',
            intent: 'listado_citas',
            shape: 'lista',
            period: {
                type: 'hoy',
                startUtc: '2026-10-29T06:00:00.000Z',
                endUtc: '2026-10-30T05:59:59.999Z',
                startLocal: '2026-10-29',
                endLocal: '2026-10-29',
                label: 'Hoy (29 de octubre de 2026)',
                timezone: 'America/Mexico_City',
            },
            interpretation: 'Citas programadas para hoy',
            narrative: 'Tienes 1 cita programada hoy a las 16:00 horas con Dr. Pérez.',
            data: [
                {
                    customer_name: 'Dr. Pérez',
                    start_time: '2026-10-29T22:00:00.000Z',
                    end_time: '2026-10-29T23:00:00.000Z',
                    status: 'confirmada',
                },
            ],
            warnings: [],
        };

        const html = formatHarnessResponseForTelegram(res);
        // Debe mostrar 16:00 y no 22:00
        expect(html).toContain('16:00');
        expect(html).toContain('17:00');
        expect(html).not.toContain('22:00:00');
        expect(html).not.toContain('23:00:00');
        expect(html).toContain('<b>Start time:</b> 2026-10-29 16:00');
        expect(html).toContain('<b>End time:</b> 2026-10-29 17:00');
    });
});
