/**
 * Conversor mínimo y seguro de un subconjunto de Markdown a HTML, para
 * `bodyMarkdown` de `send-template-email`
 * (docs/tasks/send-template-email-backend.md). Deliberadamente NO usa una
 * librería de markdown completa (AGENTS.md: "ninguna dependencia nueva sin
 * justificar"): todo el texto se escapa primero, así que no hay forma de que
 * una sintaxis no reconocida termine renderizando HTML crudo — a diferencia
 * de librerías como `marked`, que por defecto dejan pasar HTML embebido en
 * el markdown de origen. El correo resultante lo reciben los contactos del
 * CRM, no solo quien lo escribió, así que ese passthrough sería una vía de
 * inyección si una cuenta de la organización se ve comprometida.
 *
 * Soporta: **negrita**, [texto](url) (solo esquemas http(s)/mailto —
 * cualquier otro, incluido javascript:, se deja como texto plano), párrafos
 * separados por línea en blanco, saltos de línea simples dentro de un
 * párrafo.
 */

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const SAFE_LINK_PROTOCOLS = /^(https?:|mailto:)/i;

function renderInline(escapedLine: string): string {
    // El texto y la URL ya vienen escapados (se opera sobre `escapedLine`);
    // los esquemas http(s)/mailto no contienen caracteres que el escape
    // altere, así que la validación de esquema es segura hacerla aquí.
    let result = escapedLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text: string, url: string) => {
        if (!SAFE_LINK_PROTOCOLS.test(url)) {
            return match; // Esquema no permitido (ej. javascript:): se deja como texto plano.
        }
        return `<a href="${url}" style="color: inherit; text-decoration: underline;">${text}</a>`;
    });

    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    return result;
}

function stripMarkdownSyntax(markdown: string): string {
    return markdown
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) =>
            SAFE_LINK_PROTOCOLS.test(url) ? `${text} (${url})` : text
        )
        .replace(/\*\*([^*]+)\*\*/g, '$1');
}

export interface RenderedMarkdownLite {
    /** Párrafos ya como `<p>...</p>`, listos para insertarse en una sección del renderer de correo. */
    html: string;
    /** Versión de texto plano equivalente, para el alternativo `text/plain` del correo. */
    text: string;
}

/**
 * Convierte `bodyMarkdown` (ya interpolado con las variables del contacto) a
 * un fragmento HTML seguro y a su equivalente en texto plano.
 */
export function renderMarkdownLite(markdown: string): RenderedMarkdownLite {
    const trimmed = markdown.trim();
    const escaped = escapeHtml(trimmed);

    const paragraphs = escaped
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => renderInline(p).replace(/\n/g, '<br/>'));

    const html = paragraphs.map((p) => `<p style="margin: 0 0 12px 0;">${p}</p>`).join('');

    return { html, text: stripMarkdownSyntax(trimmed) };
}
