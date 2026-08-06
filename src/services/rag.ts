import OpenAI from 'openai';
import dotenv from 'dotenv';
import { supabaseAdmin } from '../lib/supabase.js';

dotenv.config();

let openaiInstance: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
    if (!openaiInstance) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('Falta la variable de entorno OPENAI_API_KEY en el archivo .env');
        }
        openaiInstance = new OpenAI({ apiKey });
    }
    return openaiInstance;
}


/**
 * Genera un embedding vectorial de 1536 dimensiones para un texto dado
 * utilizando el modelo `text-embedding-3-small` de OpenAI.
 *
 * @param text - El texto a convertir en embedding.
 * @returns Promesa que resuelve a un arreglo de números (vector embedding).
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim() === '') {
        throw new Error('El texto para generar el embedding no puede estar vacío.');
    }

    const openai = getOpenAIClient();
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });

    if (!response.data || response.data.length === 0) {
        throw new Error('OpenAI no retornó embeddings para el texto proporcionado.');
    }

    return response.data[0].embedding;
}

/**
 * Genera el embedding de un contenido e inserta un nuevo chunk de conocimiento
 * en la tabla `knowledge_base` de Supabase.
 *
 * @param orgId - ID de la organización asociada.
 * @param title - Título o encabezado del chunk.
 * @param content - Contenido textual del chunk.
 * @param metadata - Objeto opcional de metadatos adicionales.
 * @returns El registro insertado en la base de datos.
 */
export async function insertKnowledgeChunk(
    orgId: string,
    title: string,
    content: string,
    metadata: Record<string, any> = {}
) {
    const embedding = await generateEmbedding(content);

    const { data, error } = await supabaseAdmin
        .from('knowledge_base')
        .insert({
            organization_id: orgId,
            title,
            content,
            embedding,
            metadata: metadata || {},
        })
        .select()
        .single();

    if (error) {
        throw new Error(`Error al insertar chunk en la base de conocimiento: ${error.message}`);
    }

    return data;
}

/**
 * Genera el embedding del query y ejecuta la función RPC `match_documents` de Supabase
 * para obtener los documentos más relevantes de una organización específica.
 *
 * @param orgId - ID de la organización para filtrar.
 * @param query - Consulta de búsqueda en texto plano.
 * @param limit - Número máximo de resultados a retornar (por defecto 5).
 * @returns Lista de documentos/chunks coincidentes.
 */
export async function searchKnowledgeBase(
    orgId: string,
    query: string,
    limit: number = 5
) {
    const query_embedding = await generateEmbedding(query);

    const { data, error } = await supabaseAdmin.rpc('match_documents', {
        query_embedding,
        match_count: limit,
        filter_org_id: orgId,
    });

    if (error) {
        throw new Error(`Error al buscar en la base de conocimiento via RPC: ${error.message}`);
    }

    return data;
}
