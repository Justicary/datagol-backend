import { z } from 'zod';

/**
 * Esquemas de `POST /tools/:webhookToken/products` (FASE D,
 * docs/tasks/catalogo-productos-grupos-cred.md). Mismo criterio de
 * `schemas/tool-routes.ts`: laxo en el formato exacto porque el remitente es
 * el LLM del agente de voz, no un cliente HTTP estricto.
 */

// Máximo alineado con "ofrezca máximo dos o tres productos por turno" (FASE
// G, mismo criterio que availabilityResponseSchema.slots.max(2)) — se acepta
// una lista más larga sin rechazarla (un 400 no es verbalizable), pero solo
// se procesan los primeros 3.
export const MAX_SKUS_PER_REQUEST = 3;

export const productsToolBodySchema = z.object({
    skus: z.array(z.string().min(1)).min(1),
});
export type ProductsToolBody = z.infer<typeof productsToolBodySchema>;

export const productResultSchema = z.object({
    sku: z.string(),
    found: z.boolean(),
    // Ausentes cuando found=false — nunca 0/"" como relleno, que un LLM
    // podría leer como un valor real.
    presentation: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    priceIncludesTax: z.boolean().nullable().optional(),
    // Texto ya matizado (FASE D, mapeo de stock_status) — nunca "sí tenemos"
    // ni una cifra de existencias. El backend decide la redacción exacta;
    // el system prompt (FASE G) refuerza, no reemplaza, esta matización.
    availabilityText: z.string().nullable().optional(),
    // El agente de voz no puede usarla (canal de audio); los canales de
    // texto (WhatsApp) sí. Se incluye siempre — es el mismo webhook para
    // ambos canales, e inofensiva cuando el consumidor es voz.
    imageUrl: z.string().nullable().optional(),
});
export type ProductResult = z.infer<typeof productResultSchema>;

export const productsToolResponseSchema = z.object({
    results: z.array(productResultSchema),
    // Presente solo en degradación total (feature deshabilitada, fallo de
    // base de datos) — nunca junto con `results` poblado.
    message: z.string().optional(),
});
export type ProductsToolResponse = z.infer<typeof productsToolResponseSchema>;
