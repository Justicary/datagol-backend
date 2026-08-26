/**
 * Escape mínimo de HTML para interpolar texto dinámico (nombre de negocio,
 * nombre de cliente) en páginas o correos generados por el backend. Nunca
 * confiar en que el dato ya viene limpio: viaja desde `contacts`/`organizations`,
 * poblado en última instancia por lo que alguien dictó en una llamada.
 */
export function escapeHtml(str: unknown): string {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
