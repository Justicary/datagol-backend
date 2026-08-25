/**
 * Cliente de la knowledge base de ElevenLabs Conversational AI (FASE C.2,
 * docs/tasks/catalogo-productos-grupos-cred.md).
 *
 * Verificado contra la documentación oficial de ElevenLabs Conversational AI:
 * (https://elevenlabs.io/docs/api-reference/knowledge-base/create-from-text)
 * Endpoints implementados:
 *   - POST   /v1/convai/knowledge-base/text                   (crear documento de texto con parent_folder_id)
 *   - PATCH  /v1/convai/knowledge-base/:documentId            (actualizar nombre/contenido)
 *   - DELETE /v1/convai/knowledge-base/:documentId            (eliminar documento de la KB)
 *   - POST   /v1/convai/knowledge-base/:documentId/rag-index  (calcular/recalcular índice RAG)
 *   - POST   /v1/convai/knowledge-base/folder                 (crear carpeta en KB)
 *   - GET    /v1/convai/knowledge-base                        (listado y uso de KB)
 * Todos con header `xi-api-key`, misma convención que el resto del código
 * (ElevenLabsAdapter.ts, check-elevenlabs-credits.ts).
 */

const ELEVENLABS_KB_BASE_URL = 'https://api.elevenlabs.io/v1/convai/knowledge-base';
const ELEVENLABS_TIMEOUT_MS = 30_000;
export const ELEVENLABS_DEFAULT_RAG_MODEL = 'e5_mistral_7b_instruct';

export class ElevenLabsKbError extends Error {
    constructor(
        message: string,
        public readonly status: number
    ) {
        super(message);
        this.name = 'ElevenLabsKbError';
    }
}

interface CreateOrUpdateKbTextDocumentParams {
    apiKey: string;
    /** `product_kb_sync.kb_document_id` existente, o `null` para crear uno nuevo. */
    existingDocumentId: string | null;
    name: string;
    content: string;
    /** Carpeta del catálogo (FASE C.2: "usar una carpeta por catálogo"). */
    folderId: string | null;
}

export interface KbDocumentResult {
    documentId: string;
}

/**
 * Crea o actualiza el documento de texto de un producto. `existingDocumentId`
 * decide la operación: `null` crea (POST a /text), un valor existente actualiza
 * (PATCH a /:documentId) — nunca se crea un documento duplicado para el mismo producto.
 */
export async function createOrUpdateKbTextDocument(params: CreateOrUpdateKbTextDocumentParams): Promise<KbDocumentResult> {
    const { apiKey, existingDocumentId, name, content, folderId } = params;

    const url = existingDocumentId ? `${ELEVENLABS_KB_BASE_URL}/${existingDocumentId}` : `${ELEVENLABS_KB_BASE_URL}/text`;
    const method = existingDocumentId ? 'PATCH' : 'POST';

    const payload = existingDocumentId
        ? { name, content }
        : { name, text: content, ...(folderId ? { parent_folder_id: folderId } : {}) };

    const response = await fetch(url, {
        method,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new ElevenLabsKbError(
            `ElevenLabs devolvió ${response.status} al ${existingDocumentId ? 'actualizar' : 'crear'} el documento de KB "${name}": ${errorText}`,
            response.status
        );
    }

    const body = (await response.json()) as { id?: string; document_id?: string };
    const documentId = body.id ?? body.document_id ?? existingDocumentId;
    if (!documentId) {
        throw new ElevenLabsKbError(`ElevenLabs no devolvió un id de documento al ${existingDocumentId ? 'actualizar' : 'crear'} "${name}"`, response.status);
    }

    return { documentId };
}

/**
 * Elimina el documento de un producto desactivado/borrado (FASE C.2). Un 404
 * (el documento ya no existe del lado de ElevenLabs) se trata como éxito —
 * el estado deseado ("no existe") ya se cumple.
 */
export async function deleteKbDocument(apiKey: string, documentId: string): Promise<void> {
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/${documentId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 404) {
        const errorText = await response.text().catch(() => '');
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al eliminar el documento de KB ${documentId}: ${errorText}`, response.status);
    }
}

/**
 * Dispara el recálculo del índice RAG del documento — paso asíncrono aparte
 * (FASE C.2): sin esto, el documento existe en la KB pero no se recupera en
 * búsquedas semánticas durante la conversación. Requiere especificar el modelo
 * (por defecto: e5_mistral_7b_instruct).
 */
export async function triggerRagIndex(
    apiKey: string,
    documentId: string,
    model: string = ELEVENLABS_DEFAULT_RAG_MODEL
): Promise<void> {
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/${documentId}/rag-index`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // Si ElevenLabs devuelve 422 indicando que el documento ya se encuentra en procesamiento o indexado,
        // no se considera un fallo fatal (ya está en curso).
        if (response.status === 422 && (errorText.includes('processing') || errorText.includes('already'))) {
            return;
        }
        throw new ElevenLabsKbError(
            `ElevenLabs devolvió ${response.status} al disparar el reindexado RAG del documento ${documentId}: ${errorText}`,
            response.status
        );
    }
}

/**
 * Crea una carpeta de knowledge base (FASE C.2: "usar una carpeta por
 * catálogo").
 */
export async function createKbFolder(apiKey: string, name: string): Promise<{ folderId: string }> {
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/folder`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al crear la carpeta de KB "${name}": ${errorText}`, response.status);
    }

    const body = (await response.json()) as { id?: string; folder_id?: string };
    const folderId = body.id ?? body.folder_id;
    if (!folderId) {
        throw new ElevenLabsKbError(`ElevenLabs no devolvió un id de carpeta al crear "${name}"`, response.status);
    }

    return { folderId };
}

export interface KbUsage {
    documentCount: number;
    /** `null` cuando la respuesta de ElevenLabs no trae un tope explícito por plan. */
    documentLimit: number | null;
}

/**
 * Tamaño actual de la KB del workspace (FASE C.3: "consulta el tamaño actual
 * antes de sincronizar y reporta cuando se acerque al límite"). Nunca lanza:
 * es un chequeo informativo que no debe bloquear la sincronización real si
 * falla — devuelve `null` y el llamador decide si loguear o continuar.
 */
export async function getKbUsage(apiKey: string): Promise<KbUsage | null> {
    try {
        const response = await fetch(`${ELEVENLABS_KB_BASE_URL}?page_size=1`, {
            headers: { 'xi-api-key': apiKey },
            signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
        });

        if (!response.ok) {
            return null;
        }

        const body = (await response.json()) as { total_count?: number; document_limit?: number };
        if (typeof body.total_count !== 'number') {
            return null;
        }

        return { documentCount: body.total_count, documentLimit: body.document_limit ?? null };
    } catch {
        return null;
    }
}
