/**
 * Valores permitidos por el CHECK constraint de `leads.source`
 * (db/migrations/39_resultado_negocio.sql). Única fuente de verdad — mismo
 * patrón que `secret-keys.ts`. `desconocido` es la salida obligatoria cuando
 * un texto libre no encaja en ninguno de los demás valores — nunca se fuerza
 * a la categoría más cercana (docs/tasks/asistencia-valor de cierre.md, D.1).
 *
 * Verificado por inserción directa contra la base real — ver
 * __tests__/lead-source.test.ts.
 */
export const LEAD_SOURCES = {
    ANUNCIO_PAGADO: 'anuncio_pagado',
    BUSQUEDA_GOOGLE: 'busqueda_google',
    REDES_SOCIALES: 'redes_sociales',
    REFERIDO: 'referido',
    SITIO_WEB: 'sitio_web',
    LETRERO_FISICO: 'letrero_fisico',
    DIRECTORIO: 'directorio',
    OTRO: 'otro',
    DESCONOCIDO: 'desconocido',
} as const;

export type LeadSource = (typeof LEAD_SOURCES)[keyof typeof LEAD_SOURCES];

export const ALL_LEAD_SOURCES: readonly LeadSource[] = Object.values(LEAD_SOURCES);

export function isLeadSource(value: string): value is LeadSource {
    return (ALL_LEAD_SOURCES as readonly string[]).includes(value);
}
