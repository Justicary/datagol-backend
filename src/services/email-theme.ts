/**
 * FASE A — Derivación del tema seguro para correos electrónicos.
 *
 * El tema guardado en `organizations->integration_settings.theme` está diseñado
 * para pantalla (rgba, variables CSS, fondos oscuros). Este módulo normaliza
 * cualquier entrada a una paleta sólida sobre fondo claro con contraste
 * verificado (WCAG AA ≥ 4.5:1).
 */

export interface SafeEmailTheme {
    accent: string;
    accentText: string;
    accentSecondary: string;
    accentSecondaryText: string;
    background: string;
    canvas: string;
    text: string;
    textMuted: string;
    border: string;
    cardBackground: string;
    buttonBackground: string;
    buttonText: string;
}

interface RGB {
    r: number;
    g: number;
    b: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function componentToHex(c: number): string {
    const hex = clamp(Math.round(c), 0, 255).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
}

function rgbToHex(rgb: RGB): string {
    return `#${componentToHex(rgb.r)}${componentToHex(rgb.g)}${componentToHex(rgb.b)}`.toLowerCase();
}

/**
 * Convierte cualquier formato de color (hex, rgb, rgba) a hex sólido de 6 caracteres.
 * Los canales alfa se mezclan matemáticamente sobre fondo blanco (#ffffff).
 */
export function parseColorToSolidHex(colorStr: unknown): string | null {
    if (typeof colorStr !== 'string') return null;
    const str = colorStr.trim();
    if (!str) return null;

    // 1. Hex: #RGB o #RRGGBB o #RRGGBBAA
    if (str.startsWith('#')) {
        const hex = str.slice(1);
        if (/^[0-9a-fA-F]{3}$/.test(hex)) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            return rgbToHex({ r, g, b });
        }
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            return `#${hex.toLowerCase()}`;
        }
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const a = parseInt(hex.slice(6, 8), 16) / 255;
            // Mezcla alfa sobre blanco (#ffffff)
            const blendedR = Math.round(r * a + 255 * (1 - a));
            const blendedG = Math.round(g * a + 255 * (1 - a));
            const blendedB = Math.round(b * a + 255 * (1 - a));
            return rgbToHex({ r: blendedR, g: blendedG, b: blendedB });
        }
        return null;
    }

    // 2. RGBA o RGB: rgba(18, 18, 23, 0.75) o rgb(18, 18, 23)
    const rgbaMatch = str.match(/rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (rgbaMatch) {
        const r = parseFloat(rgbaMatch[1]);
        const g = parseFloat(rgbaMatch[2]);
        const b = parseFloat(rgbaMatch[3]);
        const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;

        if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return null;

        const clampedA = clamp(a, 0, 1);
        const blendedR = Math.round(clamp(r, 0, 255) * clampedA + 255 * (1 - clampedA));
        const blendedG = Math.round(clamp(g, 0, 255) * clampedA + 255 * (1 - clampedA));
        const blendedB = Math.round(clamp(b, 0, 255) * clampedA + 255 * (1 - clampedA));
        return rgbToHex({ r: blendedR, g: blendedG, b: blendedB });
    }

    return null;
}

function hexToRgb(hex: string): RGB | null {
    const clean = hex.replace('#', '');
    if (clean.length !== 6) return null;
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r, g, b };
}

/**
 * Calcula la luminancia relativa según estándar WCAG 2.1.
 */
function getRelativeLuminance(rgb: RGB): number {
    const srgb = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
    const linear = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Calcula la relación de contraste entre dos colores hex (rango 1:1 a 21:1).
 */
export function getContrastRatio(hex1: string, hex2: string): number {
    const rgb1 = hexToRgb(hex1);
    const rgb2 = hexToRgb(hex2);
    if (!rgb1 || !rgb2) return 1;

    const l1 = getRelativeLuminance(rgb1);
    const l2 = getRelativeLuminance(rgb2);

    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);

    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Oscurece un color hex hacia negro (#000000) hasta alcanzar el ratio mínimo de contraste contra blanco (#ffffff).
 * WCAG AA normal text exige ≥ 4.5:1.
 */
export function ensureContrastAgainstWhite(hexColor: string, minRatio = 4.5): string {
    const rgb = hexToRgb(hexColor);
    if (!rgb) return '#2563eb';

    const whiteHex = '#ffffff';
    let currentRatio = getContrastRatio(hexColor, whiteHex);
    if (currentRatio >= minRatio) {
        return hexColor.toLowerCase();
    }

    let r = rgb.r;
    let g = rgb.g;
    let b = rgb.b;

    // Oscurecer iterativamente hasta que el contraste sea suficiente o lleguemos a negro
    for (let step = 0; step < 50; step++) {
        r = Math.floor(r * 0.92);
        g = Math.floor(g * 0.92);
        b = Math.floor(b * 0.92);

        const currentHex = rgbToHex({ r, g, b });
        currentRatio = getContrastRatio(currentHex, whiteHex);
        if (currentRatio >= minRatio) {
            return currentHex;
        }
    }

    return rgbToHex({ r, g, b });
}

export const DEFAULT_DATAGOL_EMAIL_THEME: SafeEmailTheme = {
    accent: '#2563eb',
    accentText: '#2563eb',
    accentSecondary: '#2563eb',
    accentSecondaryText: '#2563eb',
    background: '#ffffff',
    canvas: '#f4f6f8',
    text: '#1f2937',
    textMuted: '#64748b',
    border: '#e5e7eb',
    cardBackground: '#f8fafc',
    buttonBackground: '#2563eb',
    buttonText: '#ffffff',
};

/**
 * Deriva una paleta segura para correo a partir de la configuración de tema del cliente.
 * Ignora propiedades exclusivas de pantalla (background, surface, typography, etc.).
 */
export function deriveSafeEmailTheme(themeInput?: unknown): SafeEmailTheme {
    let rawAccent: unknown = null;
    let rawAccentSecondary: unknown = null;

    if (themeInput && typeof themeInput === 'object') {
        const t = themeInput as Record<string, unknown>;
        rawAccent = t.accentColor ?? t.accent ?? t.primary ?? null;
        rawAccentSecondary = t.accentSecondary ?? t.secondary ?? null;
    } else if (typeof themeInput === 'string') {
        rawAccent = themeInput;
    }

    const parsedAccent = parseColorToSolidHex(rawAccent) || DEFAULT_DATAGOL_EMAIL_THEME.accent;
    const parsedSecondary = parseColorToSolidHex(rawAccentSecondary) || parsedAccent;

    const accentText = ensureContrastAgainstWhite(parsedAccent, 4.5);
    const accentSecondaryText = ensureContrastAgainstWhite(parsedSecondary, 4.5);

    // Calcular color de texto de botón según el contraste del fondo del botón
    const buttonBgContrastWithWhite = getContrastRatio(parsedAccent, '#ffffff');
    const buttonText = buttonBgContrastWithWhite >= 3.0 ? '#ffffff' : '#111827';

    return {
        accent: parsedAccent,
        accentText,
        accentSecondary: parsedSecondary,
        accentSecondaryText,
        background: '#ffffff',
        canvas: '#f4f6f8',
        text: '#1f2937',
        textMuted: '#64748b',
        border: '#e5e7eb',
        cardBackground: '#f8fafc',
        buttonBackground: parsedAccent,
        buttonText,
    };
}
