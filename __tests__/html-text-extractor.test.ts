import { describe, it, expect } from 'vitest';
import { extractVisibleText } from '../src/lib/html-text-extractor.js';

describe('lib/html-text-extractor.ts', () => {
    it('quita script y style, conserva el texto visible', () => {
        const html = `<html><head><style>body{color:red}</style><script>alert('x')</script></head>
            <body><h1>Promoción de verano</h1><p>20% de descuento en todos los servicios.</p></body></html>`;
        const text = extractVisibleText(html);
        expect(text).toContain('Promoción de verano');
        expect(text).toContain('20% de descuento en todos los servicios.');
        expect(text).not.toContain('color:red');
        expect(text).not.toContain('alert');
    });

    it('quita comentarios HTML', () => {
        const html = `<div><!-- nota interna, no debe aparecer -->Contenido real</div>`;
        const text = extractVisibleText(html);
        expect(text).toContain('Contenido real');
        expect(text).not.toContain('nota interna');
    });

    it('decodifica entidades comunes', () => {
        const html = `<p>Precios &amp; promociones &mdash; hoy &lt;con descuento&gt;</p>`;
        const text = extractVisibleText(html);
        expect(text).toContain('Precios & promociones — hoy <con descuento>');
    });

    it('separa etiquetas de bloque en líneas distintas, sin pegar palabras', () => {
        const html = `<div>Uno</div><div>Dos</div>`;
        const text = extractVisibleText(html);
        expect(text.split('\n')).toEqual(['Uno', 'Dos']);
    });

    it('colapsa espacios en blanco y descarta líneas vacías', () => {
        const html = `<p>   con   espacios   </p><p>   </p><p>final</p>`;
        const text = extractVisibleText(html);
        expect(text.split('\n')).toEqual(['con espacios', 'final']);
    });
});
