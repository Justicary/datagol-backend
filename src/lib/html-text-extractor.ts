/**
 * Extractor de texto visible desde HTML crudo (Fase C — "guardar únicamente
 * texto extraído, nunca el HTML completo"). Deliberadamente simple: no es un
 * parser DOM, es una cadena de reemplazos de texto. Suficiente para detectar
 * cambios de contenido semana a semana (C.3), no para preservar estructura
 * ni maquetación. No se agregó `cheerio`/`jsdom` como dependencia nueva para
 * esto — ver docs/tasks/reportes-semanales.md, notas de la Fase C.
 */

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    copy: '©',
    reg: '®',
    trade: '™',
};

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&([a-zA-Z]+);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Quita `<script>`/`<style>`/comentarios, convierte etiquetas de bloque en
 * saltos de línea (para no pegar palabras de celdas/párrafos distintos),
 * quita el resto de las etiquetas, decodifica entidades comunes y colapsa
 * espacios en blanco.
 */
export function extractVisibleText(html: string): string {
    let text = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|li|tr|h[1-6]|br)\s*>/gi, '\n')
        .replace(/<(br)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');

    text = decodeHtmlEntities(text);

    return text
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .join('\n');
}
