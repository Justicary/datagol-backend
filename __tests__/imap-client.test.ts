import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectMock = vi.fn();
const logoutMock = vi.fn();
const searchMock = vi.fn();
const fetchMock = vi.fn();
const fetchOneMock = vi.fn();
const lockReleaseMock = vi.fn();
const getMailboxLockMock = vi.fn().mockImplementation(async () => ({ release: lockReleaseMock }));
let lastImapFlowConfig: unknown = null;

vi.mock('imapflow', () => ({
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock(config: unknown) {
        lastImapFlowConfig = config;
        return {
            connect: connectMock,
            logout: logoutMock,
            getMailboxLock: getMailboxLockMock,
            search: searchMock,
            fetch: fetchMock,
            fetchOne: fetchOneMock,
        };
    }),
}));

const simpleParserMock = vi.fn();
vi.mock('mailparser', () => ({
    simpleParser: (...args: unknown[]) => simpleParserMock(...args),
}));

const htmlToTextMock = vi.fn();
vi.mock('html-to-text', () => ({
    convert: (...args: unknown[]) => htmlToTextMock(...args),
}));

import {
    verifyImapConnection,
    searchInbox,
    getMessageDetail,
    ImapConnectionError,
} from '../src/services/email/imap-client.js';

const CONFIG = { host: 'imap.example.invalid', port: 993, secure: true, user: 'usuario', pass: 'clave' };

function asyncIterableFrom<T>(items: T[]) {
    let i = 0;
    return {
        [Symbol.asyncIterator]: () => ({
            next: async () => (i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }),
        }),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    lastImapFlowConfig = null;
    getMailboxLockMock.mockImplementation(async () => ({ release: lockReleaseMock }));
    connectMock.mockResolvedValue(undefined);
    logoutMock.mockResolvedValue(undefined);
});

describe('src/services/email/imap-client.ts', () => {
    describe('verifyImapConnection', () => {
        it('construye ImapFlow con exactamente el config esperado y llama connect + logout', async () => {
            await verifyImapConnection(CONFIG);
            expect(lastImapFlowConfig).toEqual({
                host: 'imap.example.invalid',
                port: 993,
                secure: true,
                auth: { user: 'usuario', pass: 'clave' },
                logger: false,
                socketTimeout: 8000,
            });
            expect(connectMock).toHaveBeenCalledTimes(1);
            expect(logoutMock).toHaveBeenCalledTimes(1);
        });

        it('envuelve el error de connect() en ImapConnectionError con el mensaje exacto', async () => {
            connectMock.mockRejectedValueOnce(new Error('bad credentials'));
            await expect(verifyImapConnection(CONFIG)).rejects.toThrow(
                new ImapConnectionError('No se pudo conectar al servidor IMAP: bad credentials')
            );
        });

        it('usa String(err) cuando el error de connect() no es una instancia de Error', async () => {
            connectMock.mockRejectedValueOnce('raw string failure');
            await expect(verifyImapConnection(CONFIG)).rejects.toThrow(
                'No se pudo conectar al servidor IMAP: raw string failure'
            );
        });

        it('no lanza si logout() falla después de un connect() exitoso (suprimido)', async () => {
            logoutMock.mockRejectedValueOnce(new Error('logout boom'));
            await expect(verifyImapConnection(CONFIG)).resolves.toBeUndefined();
        });

        it('propaga el error original de connect(), no el de logout(), cuando ambos fallan', async () => {
            connectMock.mockRejectedValueOnce(new Error('connect boom'));
            logoutMock.mockRejectedValueOnce(new Error('logout boom'));
            await expect(verifyImapConnection(CONFIG)).rejects.toThrow(
                'No se pudo conectar al servidor IMAP: connect boom'
            );
        });
    });

    describe('searchInbox', () => {
        it('sin filtros, busca con since=época 0 y limit por defecto 20', async () => {
            searchMock.mockResolvedValueOnce([]);
            await searchInbox(CONFIG, {});
            expect(searchMock).toHaveBeenCalledWith({ since: new Date(0) }, { uid: true });
        });

        it('unseenOnly:true agrega seen:false al query, sin el fallback de since=época 0', async () => {
            searchMock.mockResolvedValueOnce([]);
            await searchInbox(CONFIG, { unseenOnly: true });
            expect(searchMock).toHaveBeenCalledWith({ seen: false }, { uid: true });
        });

        it('unseenOnly ausente/false no agrega la clave seen al query', async () => {
            searchMock.mockResolvedValueOnce([]);
            await searchInbox(CONFIG, { unseenOnly: false, subject: 'hola' });
            const [query] = searchMock.mock.calls[0] as [Record<string, unknown>, unknown];
            expect(query).not.toHaveProperty('seen');
        });

        it('unseenOnly combinado con otros filtros conserva ambos en el query', async () => {
            searchMock.mockResolvedValueOnce([]);
            const since = new Date('2026-01-01T00:00:00Z');
            await searchInbox(CONFIG, { unseenOnly: true, since });
            expect(searchMock).toHaveBeenCalledWith({ since, seen: false }, { uid: true });
        });

        it('con todos los filtros, construye el query exacto (sin since=época 0)', async () => {
            searchMock.mockResolvedValueOnce([]);
            const since = new Date('2026-01-01T00:00:00Z');
            const before = new Date('2026-02-01T00:00:00Z');
            await searchInbox(CONFIG, { subject: 'hola', from: 'a@b.com', since, before });
            expect(searchMock).toHaveBeenCalledWith({ subject: 'hola', from: 'a@b.com', since, before }, { uid: true });
        });

        it('devuelve [] cuando search() devuelve false', async () => {
            searchMock.mockResolvedValueOnce(false);
            const result = await searchInbox(CONFIG, {});
            expect(result).toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('devuelve [] cuando search() devuelve un arreglo vacío', async () => {
            searchMock.mockResolvedValueOnce([]);
            const result = await searchInbox(CONFIG, {});
            expect(result).toEqual([]);
        });

        it('recorta a los últimos `limit` uids y los invierte antes de fetch()', async () => {
            searchMock.mockResolvedValueOnce([1, 2, 3, 4, 5]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([]));
            await searchInbox(CONFIG, { limit: 2 });
            expect(fetchMock).toHaveBeenCalledWith([5, 4], { envelope: true }, { uid: true });
        });

        it('el límite nunca excede MAX_SEARCH_LIMIT (50) aunque se pida más', async () => {
            const manyUids = Array.from({ length: 60 }, (_, i) => i + 1);
            searchMock.mockResolvedValueOnce(manyUids);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([]));
            await searchInbox(CONFIG, { limit: 999 });
            const calledUids = fetchMock.mock.calls[0][0] as number[];
            expect(calledUids.length).toBe(50);
        });

        it('mapea from usando address cuando está presente', async () => {
            searchMock.mockResolvedValueOnce([1]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([{ uid: 1, envelope: { from: [{ address: 'x@y.com', name: 'X' }] } }]));
            const [result] = await searchInbox(CONFIG, {});
            expect(result.from).toBe('x@y.com');
        });

        it('mapea from usando name cuando no hay address', async () => {
            searchMock.mockResolvedValueOnce([1]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([{ uid: 1, envelope: { from: [{ name: 'Solo Nombre' }] } }]));
            const [result] = await searchInbox(CONFIG, {});
            expect(result.from).toBe('Solo Nombre');
        });

        it('from es null cuando el mensaje no trae remitente', async () => {
            searchMock.mockResolvedValueOnce([1]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([{ uid: 1, envelope: {} }]));
            const [result] = await searchInbox(CONFIG, {});
            expect(result.from).toBeNull();
            expect(result.subject).toBeNull();
            expect(result.date).toBeNull();
            expect(result.snippet).toBe('');
        });

        it('date se convierte a ISO string cuando envelope.date está presente', async () => {
            searchMock.mockResolvedValueOnce([1]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([{ uid: 1, envelope: { date: '2026-03-10T08:00:00Z' } }]));
            const [result] = await searchInbox(CONFIG, {});
            expect(result.date).toBe(new Date('2026-03-10T08:00:00Z').toISOString());
        });

        it('snippet se recorta a 140 caracteres del subject', async () => {
            const longSubject = 'A'.repeat(200);
            searchMock.mockResolvedValueOnce([1]);
            fetchMock.mockReturnValueOnce(asyncIterableFrom([{ uid: 1, envelope: { subject: longSubject } }]));
            const [result] = await searchInbox(CONFIG, {});
            expect(result.snippet.length).toBe(140);
            expect(result.subject).toBe(longSubject);
        });

        it('reordena los resultados por uid descendente sin importar el orden de fetch()', async () => {
            searchMock.mockResolvedValueOnce([1, 2, 3]);
            fetchMock.mockReturnValueOnce(
                asyncIterableFrom([
                    { uid: 1, envelope: { subject: 'uno' } },
                    { uid: 3, envelope: { subject: 'tres' } },
                    { uid: 2, envelope: { subject: 'dos' } },
                ])
            );
            const results = await searchInbox(CONFIG, {});
            expect(results.map((r) => r.uid)).toEqual([3, 2, 1]);
        });

        it('libera el lock incluso si search() lanza dentro del bloque protegido', async () => {
            searchMock.mockRejectedValueOnce(new Error('search boom'));
            await expect(searchInbox(CONFIG, {})).rejects.toThrow('Error buscando correos: search boom');
            expect(lockReleaseMock).toHaveBeenCalledTimes(1);
            expect(logoutMock).toHaveBeenCalledTimes(1);
        });

        it('envuelve el error de connect() en ImapConnectionError y aun así hace logout', async () => {
            connectMock.mockRejectedValueOnce(new Error('connect boom'));
            await expect(searchInbox(CONFIG, {})).rejects.toThrow('Error buscando correos: connect boom');
            expect(logoutMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('getMessageDetail', () => {
        it('devuelve null cuando fetchOne() devuelve false, y libera el lock', async () => {
            fetchOneMock.mockResolvedValueOnce(false);
            const result = await getMessageDetail(CONFIG, 42);
            expect(result).toBeNull();
            expect(lockReleaseMock).toHaveBeenCalledTimes(1);
            expect(simpleParserMock).not.toHaveBeenCalled();
        });

        it('devuelve null cuando el mensaje no trae msg.source', async () => {
            fetchOneMock.mockResolvedValueOnce({ uid: 42, envelope: {} });
            const result = await getMessageDetail(CONFIG, 42);
            expect(result).toBeNull();
        });

        it('llama fetchOne con el uid convertido a string y las opciones esperadas', async () => {
            fetchOneMock.mockResolvedValueOnce(false);
            await getMessageDetail(CONFIG, 42);
            expect(fetchOneMock).toHaveBeenCalledWith('42', { source: true, envelope: true }, { uid: true });
        });

        it('usa parsed.text tal cual cuando no está vacío', async () => {
            const source = Buffer.from('raw');
            fetchOneMock.mockResolvedValueOnce({ uid: 1, source, envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: 'texto plano', html: false, messageId: null, inReplyTo: null });
            const result = await getMessageDetail(CONFIG, 1);
            expect(simpleParserMock).toHaveBeenCalledWith(source);
            expect(result?.bodyText).toBe('texto plano');
            expect(htmlToTextMock).not.toHaveBeenCalled();
        });

        it('convierte html a texto cuando parsed.text está vacío/whitespace y hay html', async () => {
            fetchOneMock.mockResolvedValueOnce({ uid: 1, source: Buffer.from('raw'), envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: '   ', html: '<p>hola</p>', messageId: null, inReplyTo: null });
            htmlToTextMock.mockReturnValueOnce('hola');
            const result = await getMessageDetail(CONFIG, 1);
            expect(htmlToTextMock).toHaveBeenCalledWith('<p>hola</p>', { wordwrap: false });
            expect(result?.bodyText).toBe('hola');
        });

        it('bodyText es cadena vacía cuando no hay texto ni html', async () => {
            fetchOneMock.mockResolvedValueOnce({ uid: 1, source: Buffer.from('raw'), envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: '', html: false, messageId: null, inReplyTo: null });
            const result = await getMessageDetail(CONFIG, 1);
            expect(result?.bodyText).toBe('');
            expect(result?.truncated).toBe(false);
        });

        it('trunca el cuerpo a 20000 caracteres y marca truncated:true, con el marcador exacto', async () => {
            const longText = 'x'.repeat(20050);
            fetchOneMock.mockResolvedValueOnce({ uid: 1, source: Buffer.from('raw'), envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: longText, html: false, messageId: null, inReplyTo: null });
            const result = await getMessageDetail(CONFIG, 1);
            expect(result?.truncated).toBe(true);
            expect(result?.bodyText).toBe(`${'x'.repeat(20000)}\n[... truncado ...]`);
        });

        it('no trunca cuando el cuerpo mide exactamente 20000 caracteres', async () => {
            const exactText = 'x'.repeat(20000);
            fetchOneMock.mockResolvedValueOnce({ uid: 1, source: Buffer.from('raw'), envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: exactText, html: false, messageId: null, inReplyTo: null });
            const result = await getMessageDetail(CONFIG, 1);
            expect(result?.truncated).toBe(false);
            expect(result?.bodyText).toBe(exactText);
        });

        it('mapea from, to (filtrando direcciones sin address), subject, date, messageId e inReplyTo', async () => {
            fetchOneMock.mockResolvedValueOnce({
                uid: 7,
                source: Buffer.from('raw'),
                envelope: {
                    from: [{ address: 'remitente@x.com' }],
                    to: [{ address: 'uno@x.com' }, { name: 'sin-direccion' }, { address: 'dos@x.com' }],
                    subject: 'Asunto',
                    date: '2026-05-01T00:00:00Z',
                },
            });
            simpleParserMock.mockResolvedValueOnce({ text: 'cuerpo', html: false, messageId: '<id1>', inReplyTo: '<id0>' });
            const result = await getMessageDetail(CONFIG, 7);
            expect(result).toEqual({
                uid: 7,
                from: 'remitente@x.com',
                to: ['uno@x.com', 'dos@x.com'],
                subject: 'Asunto',
                date: new Date('2026-05-01T00:00:00Z').toISOString(),
                messageId: '<id1>',
                inReplyTo: '<id0>',
                bodyText: 'cuerpo',
                truncated: false,
            });
        });

        it('from/to/subject/date/messageId/inReplyTo son null/[] cuando faltan', async () => {
            fetchOneMock.mockResolvedValueOnce({ uid: 8, source: Buffer.from('raw'), envelope: {} });
            simpleParserMock.mockResolvedValueOnce({ text: 'x', html: false, messageId: null, inReplyTo: null });
            const result = await getMessageDetail(CONFIG, 8);
            expect(result?.from).toBeNull();
            expect(result?.to).toEqual([]);
            expect(result?.subject).toBeNull();
            expect(result?.date).toBeNull();
            expect(result?.messageId).toBeNull();
            expect(result?.inReplyTo).toBeNull();
        });

        it('libera el lock y hace logout incluso si fetchOne() lanza, y registra el warning', async () => {
            const loggerModule = await import('../src/lib/logger.js');
            const warnSpy = vi.spyOn(loggerModule.logger, 'warn');
            fetchOneMock.mockRejectedValueOnce(new Error('fetch boom'));

            await expect(getMessageDetail(CONFIG, 9)).rejects.toThrow(
                new ImapConnectionError('Error obteniendo el correo: fetch boom')
            );
            expect(lockReleaseMock).toHaveBeenCalledTimes(1);
            expect(logoutMock).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ uid: 9, msg: 'fetch boom' }),
                '[ImapClient] Error obteniendo detalle del mensaje'
            );
            warnSpy.mockRestore();
        });

        it('envuelve el error de connect() con el mismo mensaje que un fallo de fetchOne', async () => {
            connectMock.mockRejectedValueOnce(new Error('connect boom'));
            await expect(getMessageDetail(CONFIG, 1)).rejects.toThrow('Error obteniendo el correo: connect boom');
            expect(logoutMock).toHaveBeenCalledTimes(1);
        });
    });
});
