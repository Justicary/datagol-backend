/**
 * Parser mínimo de `robots.txt` (Fase C, docs/tasks/reportes-semanales.md
 * C.2 — "respetar robots.txt"). Deliberadamente simple: coincidencia de
 * prefijo de ruta únicamente, sin soporte de comodines `*`/`$` (extensión de
 * facto de Google, no parte del estándar original) — suficiente para el
 * caso de uso real (verificar si SOLO la URL configurada por el admin está
 * permitida), no un crawler que necesite cubrir cada variante de patrón.
 */

interface RobotsRule {
    type: 'allow' | 'disallow';
    path: string;
}

interface RobotsBlock {
    userAgents: string[];
    rules: RobotsRule[];
}

function parseRobotsTxt(content: string): RobotsBlock[] {
    const blocks: RobotsBlock[] = [];
    let current: RobotsBlock | null = null;
    let inAgentGroup = false;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.split('#')[0].trim();
        if (!line) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const field = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();

        if (field === 'user-agent') {
            if (!inAgentGroup || !current) {
                current = { userAgents: [], rules: [] };
                blocks.push(current);
            }
            current.userAgents.push(value.toLowerCase());
            inAgentGroup = true;
        } else if (field === 'disallow' || field === 'allow') {
            if (!current) continue;
            inAgentGroup = false;
            current.rules.push({ type: field, path: value });
        }
        // Otros campos (Sitemap, Crawl-delay, etc.) se ignoran deliberadamente.
    }

    return blocks;
}

function findApplicableBlock(blocks: RobotsBlock[], userAgent: string): RobotsBlock | null {
    const ua = userAgent.toLowerCase();
    const specific = blocks.find((b) => b.userAgents.some((a) => a !== '*' && ua.includes(a)));
    if (specific) return specific;
    return blocks.find((b) => b.userAgents.includes('*')) ?? null;
}

/**
 * `true` si `path` está permitido para `userAgent` según `robotsTxtContent`.
 * Sin bloque aplicable, o sin reglas, o `robotsTxtContent` vacío → permitido
 * (mismo comportamiento que "no existe robots.txt").
 */
export function isPathAllowed(robotsTxtContent: string, userAgent: string, path: string): boolean {
    const blocks = parseRobotsTxt(robotsTxtContent);
    const block = findApplicableBlock(blocks, userAgent);
    if (!block || block.rules.length === 0) return true;

    let bestMatch: RobotsRule | null = null;
    for (const rule of block.rules) {
        // `Disallow:` vacío es "no prohíbe nada" (equivalente a permitir
        // todo), no una regla de prefijo de longitud 0 — se ignora.
        if (rule.type === 'disallow' && rule.path === '') continue;
        if (path.startsWith(rule.path) && (!bestMatch || rule.path.length > bestMatch.path.length)) {
            bestMatch = rule;
        }
    }

    if (!bestMatch) return true;
    return bestMatch.type === 'allow';
}
