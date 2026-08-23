import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    createOrUpdateKbTextDocument,
    deleteKbDocument,
    triggerRagIndex,
    getKbUsage,
    createKbFolder,
    ElevenLabsKbError,
} from '../src/services/elevenlabs-kb-client.js';

/**
 * Red saliente a api.elevenlabs.io siempre mockeada — es un proveedor de
 * pago de terceros y su contrato exacto NO está verificado (ver comentario
 * en src/services/elevenlabs-kb-client.ts). Estas pruebas fijan el
 * comportamiento asumido del cliente, no el de la API real.
 */
afterEach(() => {
    vi.restoreAllMocks();
});

function mockFetchOnce(response: Response) {
    return vi.spyOn(global, 'fetch').mockResolvedValueOnce(response);
}

describe('src/services/elevenlabs-kb-client.ts', () => {
    describe('createOrUpdateKbTextDocument', () => {
        it('sin existingDocumentId, hace POST a .../text (crear)', async () => {
            const fetchSpy = mockFetchOnce(new Response(JSON.stringify({ id: 'doc_new_123' }), { status: 200 }));

            const result = await createOrUpdateKbTextDocument({
                apiKey: 'key123',
                existingDocumentId: null,
                name: 'SKU: ARN-GEL-060',
                content: 'contenido de prueba',
                folderId: 'folder-abc',
            });

            expect(result.documentId).toBe('doc_new_123');
            const [url, init] = fetchSpy.mock.calls[0];
            expect(String(url)).toContain('/knowledge-base/text');
            expect(String(url)).not.toContain('/knowledge-base/text/');
            expect((init as RequestInit).method).toBe('POST');
            expect((init as RequestInit).headers).toMatchObject({ 'xi-api-key': 'key123' });
            expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ folder_id: 'folder-abc' });
        });

        it('contraparte: con existingDocumentId, hace PATCH al documento existente (actualizar, no duplicar)', async () => {
            const fetchSpy = mockFetchOnce(new Response(JSON.stringify({ id: 'doc_existing_456' }), { status: 200 }));

            const result = await createOrUpdateKbTextDocument({
                apiKey: 'key123',
                existingDocumentId: 'doc_existing_456',
                name: 'SKU: ARN-GEL-060',
                content: 'contenido actualizado',
                folderId: null,
            });

            expect(result.documentId).toBe('doc_existing_456');
            const [url, init] = fetchSpy.mock.calls[0];
            expect(String(url)).toContain('/knowledge-base/text/doc_existing_456');
            expect((init as RequestInit).method).toBe('PATCH');
        });

        it('respuesta no-ok lanza ElevenLabsKbError con el status', async () => {
            mockFetchOnce(new Response('error', { status: 500 }));

            await expect(
                createOrUpdateKbTextDocument({ apiKey: 'key123', existingDocumentId: null, name: 'x', content: 'y', folderId: null })
            ).rejects.toThrow(ElevenLabsKbError);
        });
    });

    describe('deleteKbDocument', () => {
        it('hace DELETE al documento', async () => {
            const fetchSpy = mockFetchOnce(new Response(null, { status: 200 }));
            await deleteKbDocument('key123', 'doc_to_delete');
            const [url, init] = fetchSpy.mock.calls[0];
            expect(String(url)).toContain('/knowledge-base/text/doc_to_delete');
            expect((init as RequestInit).method).toBe('DELETE');
        });

        it('404 (ya no existe) se trata como éxito, no lanza', async () => {
            mockFetchOnce(new Response(null, { status: 404 }));
            await expect(deleteKbDocument('key123', 'doc_ya_borrado')).resolves.not.toThrow();
        });

        it('contraparte: un error real (500) sí lanza', async () => {
            mockFetchOnce(new Response(null, { status: 500 }));
            await expect(deleteKbDocument('key123', 'doc_x')).rejects.toThrow(ElevenLabsKbError);
        });
    });

    describe('triggerRagIndex', () => {
        it('hace POST a .../rag-index', async () => {
            const fetchSpy = mockFetchOnce(new Response(JSON.stringify({}), { status: 200 }));
            await triggerRagIndex('key123', 'doc_abc');
            const [url, init] = fetchSpy.mock.calls[0];
            expect(String(url)).toContain('/knowledge-base/doc_abc/rag-index');
            expect((init as RequestInit).method).toBe('POST');
        });

        it('respuesta no-ok lanza ElevenLabsKbError', async () => {
            mockFetchOnce(new Response(null, { status: 429 }));
            await expect(triggerRagIndex('key123', 'doc_abc')).rejects.toThrow(ElevenLabsKbError);
        });
    });

    describe('createKbFolder', () => {
        it('hace POST a .../folder y devuelve el folderId', async () => {
            const fetchSpy = mockFetchOnce(new Response(JSON.stringify({ id: 'folder_xyz' }), { status: 200 }));
            const result = await createKbFolder('key123', 'Catálogo de farmacia');
            expect(result.folderId).toBe('folder_xyz');
            const [url, init] = fetchSpy.mock.calls[0];
            expect(String(url)).toContain('/knowledge-base/folder');
            expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Catálogo de farmacia' });
        });

        it('respuesta no-ok lanza ElevenLabsKbError', async () => {
            mockFetchOnce(new Response(null, { status: 500 }));
            await expect(createKbFolder('key123', 'x')).rejects.toThrow(ElevenLabsKbError);
        });
    });

    describe('getKbUsage', () => {
        it('devuelve documentCount/documentLimit cuando la respuesta trae total_count', async () => {
            mockFetchOnce(new Response(JSON.stringify({ total_count: 42, document_limit: 300 }), { status: 200 }));
            const usage = await getKbUsage('key123');
            expect(usage).toEqual({ documentCount: 42, documentLimit: 300 });
        });

        it('contraparte de rechazo: respuesta sin total_count devuelve null, nunca lanza (chequeo informativo)', async () => {
            mockFetchOnce(new Response(JSON.stringify({}), { status: 200 }));
            expect(await getKbUsage('key123')).toBeNull();
        });

        it('un fallo de red devuelve null en vez de lanzar', async () => {
            vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network down'));
            expect(await getKbUsage('key123')).toBeNull();
        });
    });
});
