import { describe, it, expect } from 'vitest';
import { isPathAllowed } from '../src/lib/robots-txt.js';

const UA = 'Datagol-CompetitorBot/1.0 (+https://datagol.net/bot)';

describe('lib/robots-txt.ts', () => {
    it('permite todo si robots.txt está vacío', () => {
        expect(isPathAllowed('', UA, '/promociones')).toBe(true);
    });

    it('rechaza una ruta prohibida para "*" cuando no hay bloque específico', () => {
        const robots = `User-agent: *\nDisallow: /admin`;
        expect(isPathAllowed(robots, UA, '/admin/panel')).toBe(false);
        expect(isPathAllowed(robots, UA, '/promociones')).toBe(true);
    });

    it('contraparte de éxito: permite una ruta que no coincide con ningún Disallow', () => {
        const robots = `User-agent: *\nDisallow: /admin\nDisallow: /checkout`;
        expect(isPathAllowed(robots, UA, '/servicios')).toBe(true);
    });

    it('Disallow vacío significa "permite todo"', () => {
        const robots = `User-agent: *\nDisallow:`;
        expect(isPathAllowed(robots, UA, '/lo-que-sea')).toBe(true);
    });

    it('usa el bloque específico de nuestro user-agent en vez de "*" si existe', () => {
        const robots = `User-agent: *\nDisallow: /\nUser-agent: Datagol-CompetitorBot\nDisallow: /admin`;
        expect(isPathAllowed(robots, UA, '/servicios')).toBe(true);
        expect(isPathAllowed(robots, UA, '/admin/x')).toBe(false);
    });

    it('Allow con prefijo más largo gana sobre un Disallow más corto', () => {
        const robots = `User-agent: *\nDisallow: /promos\nAllow: /promos/publicas`;
        expect(isPathAllowed(robots, UA, '/promos/publicas/verano')).toBe(true);
        expect(isPathAllowed(robots, UA, '/promos/privadas')).toBe(false);
    });

    it('ignora comentarios y líneas irrelevantes (Sitemap, Crawl-delay)', () => {
        const robots = `# comentario\nUser-agent: *\nCrawl-delay: 5\nSitemap: https://x.com/sitemap.xml\nDisallow: /admin`;
        expect(isPathAllowed(robots, UA, '/admin')).toBe(false);
        expect(isPathAllowed(robots, UA, '/otra-cosa')).toBe(true);
    });
});
