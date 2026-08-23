/**
 * Cliente de la knowledge base de ElevenLabs Conversational AI (FASE C.2,
 * docs/tasks/catalogo-productos-grupos-cred.md).
 *
 * NO VERIFICADO contra la documentación/API vigente de ElevenLabs — decisión
 * explícita del usuario: implementar con mejor esfuerzo contra los endpoints
 * públicos de Conversational AI tal como se conocen, dejando comentado
 * dónde verificar antes de producción (mismo criterio que
 * db/migrations/15_llm_token_provider_rates.sql con las tarifas de LLM).
 * Endpoints asumidos:
 *   - POST   /v1/convai/knowledge-base/text        (crear documento de texto)
 *   - PATCH  /v1/convai/knowledge-base/:documentId  (actualizar contenido)
 *   - DELETE /v1/convai/knowledge-base/:documentId
 *   - POST   /v1/convai/knowledge-base/:documentId/rag-index (recalcular índice RAG)
 *   - GET    /v1/convai/knowledge-base              (listado, para C.3 — tamaño/uso)
 * Todos con header `xi-api-key`, misma convención que el resto del código
 * (ElevenLabsAdapter.ts, check-elevenlabs-credits.ts).
 */

const ELEVENLABS_KB_BASE_URL = 'https://api.elevenlabs.io/v1/convai/knowledge-base';
const ELEVENLABS_TIMEOUT_MS = 15_000;

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
 * decide la operación: `null` crea (POST), un valor existente actualiza
 * (PATCH) — nunca se crea un documento duplicado para el mismo producto.
 */
export async function createOrUpdateKbTextDocument(params: CreateOrUpdateKbTextDocumentParams): Promise<KbDocumentResult> {
    const { apiKey, existingDocumentId, name, content, folderId } = params;

    const url = existingDocumentId ? `${ELEVENLABS_KB_BASE_URL}/text/${existingDocumentId}` : `${ELEVENLABS_KB_BASE_URL}/text`;
    const method = existingDocumentId ? 'PATCH' : 'POST';

    const response = await fetch(url, {
        method,
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text: content, ...(folderId ? { folder_id: folderId } : {}) }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al ${existingDocumentId ? 'actualizar' : 'crear'} el documento de KB "${name}"`, response.status);
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
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/text/${documentId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 404) {
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al eliminar el documento de KB ${documentId}`, response.status);
    }
}

/**
 * Dispara el recálculo del índice RAG del documento — paso asíncrono aparte
 * (FASE C.2): sin esto, el documento existe en la KB pero no se recupera en
 * búsquedas semánticas durante la conversación.
 */
export async function triggerRagIndex(apiKey: string, documentId: string): Promise<void> {
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/${documentId}/rag-index`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al disparar el reindexado RAG del documento ${documentId}`, response.status);
    }
}

/**
 * Crea una carpeta de knowledge base (FASE C.2: "usar una carpeta por
 * catálogo"). NO VERIFICADO — endpoint asumido, ver comentario de cabecera.
 */
export async function createKbFolder(apiKey: string, name: string): Promise<{ folderId: string }> {
    const response = await fetch(`${ELEVENLABS_KB_BASE_URL}/folder`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new ElevenLabsKbError(`ElevenLabs devolvió ${response.status} al crear la carpeta de KB "${name}"`, response.status);
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
