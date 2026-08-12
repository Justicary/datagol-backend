import { z } from 'zod';

/**
 * Esquemas Zod de `routes/widget.ts` — POST /api/widget/session (endpoint
 * público, sin sesión, invocado desde el navegador del visitante final).
 */
export const widgetSessionBodySchema = z.object({
    publicKey: z.string().min(1),
});
export type WidgetSessionBody = z.infer<typeof widgetSessionBodySchema>;

/**
 * `status: 'ok'` entrega el token efímero de conversación de ElevenLabs.
 * `status: 'degraded'` es la respuesta del cortafuegos de costo y de
 * cualquier falla del proveedor — SIEMPRE 200, nunca 429/500: el frontend
 * del widget debe poder mostrar un formulario de contacto en su lugar, no
 * un error genérico (AGENTS.md, sección "Cortafuegos de costo").
 */
export const widgetSessionResponseSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('ok'),
        signedUrl: z.string(),
    }),
    z.object({
        status: z.literal('degraded'),
        reason: z.enum(['rate_limited', 'provider_unavailable', 'provider_error']),
        message: z.string(),
    }),
]);
export type WidgetSessionResponse = z.infer<typeof widgetSessionResponseSchema>;
