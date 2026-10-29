/**
 * Servicio puro de formateo fonético y ensamble de la sección de Planes
 * para el System Prompt del Agente de Voz (ElevenLabs ConvAI).
 *
 * Convierte valores numéricos a palabras en español para garantizar
 * pronunciación perfecta en el motor TTS sin alucinaciones de cifras ni pausas.
 */

import { numberToSpanishWords } from '../lib/number-to-spanish-words.js';

export { numberToSpanishWords };

export interface PlanDataForPrompt {
    key: string;
    name: string;
    setupFeeMxn: number;
    monthlyFeeMxn: number | null;
    isPopular?: boolean;
    badge?: string | null;
    setupIncludes?: string[];
    retainerIncludes?: string[];
    showRetainer?: boolean;
    targetAudience?: string | null;
}

export const DEFAULT_PLANS_SALES_DIRECTIVE =
    'Al hablar de precios, menciona un solo plan a la vez — el que mejor encaje con lo que el cliente describió. Nunca recites los cuatro planes seguidos. Si preguntan por todos, di los nombres y pregunta cuál quieren conocer a detalle.';

/**
 * Genera el bloque de texto completo "PLANES:" a partir de las filas de planes.
 */
export function generatePlansPromptBlock(
    plans: readonly PlanDataForPrompt[],
    customSalesDirective: string = DEFAULT_PLANS_SALES_DIRECTIVE
): string {
    const lines: string[] = ['PLANES:'];

    for (const plan of plans) {
        const popularTag = plan.isPopular
            ? ', el más solicitado'
            : plan.badge
              ? `, ${plan.badge.replace(/^★\s*/, '').toLowerCase()}`
              : '';

        const setupWords = numberToSpanishWords(plan.setupFeeMxn);
        const setupPrefix = plan.monthlyFeeMxn === null && plan.key === 'enterprise'
            ? `desde ${setupWords} pesos.`
            : `instalación ${setupWords} pesos.`;

        let featuresDesc = '';
        if (plan.setupIncludes && plan.setupIncludes.length > 0) {
            featuresDesc = ` ${plan.setupIncludes.join(', ')}.`;
        } else if (plan.targetAudience) {
            featuresDesc = ` ${plan.targetAudience}.`;
        }

        let retainerText = '';
        if (plan.showRetainer !== false && plan.monthlyFeeMxn !== null && plan.monthlyFeeMxn !== undefined) {
            const monthlyWords = numberToSpanishWords(plan.monthlyFeeMxn);
            retainerText = ` Iguala opcional ${monthlyWords} pesos al mes.`;
        }

        lines.push(`${plan.name}${popularTag} — ${setupPrefix}${featuresDesc}${retainerText}`.trim());
    }

    if (customSalesDirective) {
        lines.push(customSalesDirective);
    }

    return lines.join('\n');
}

/**
 * Inyecta o reemplaza la sección PLANES:... dentro de un System Prompt existente.
 * Si ya existe una sección PLANES (con o sin dos puntos, con o sin formato markdown),
 * la reemplaza completamente en su posición original preservando el resto del prompt.
 * Si existen secciones duplicadas de PLANES (ej. añadidas al final previamente),
 * las depura para dejar una sola sección limpia.
 * Si no existe ninguna sección de planes, la añade antes de cualquier sección final o al final del prompt.
 */
export function injectPlansSectionIntoPrompt(currentPrompt: string, newPlansBlock: string): string {
    const trimmedBlock = newPlansBlock.trim();

    // Regex para detectar cualquier sección PLANES (con o sin dos puntos, con o sin # markdown)
    // que termine antes del siguiente encabezado de sección en MAYÚSCULAS o el fin del prompt.
    const plansSectionRegex = /(?:^|\n\s*)(?:#{1,3}\s*)?PLANES:?\s*\n[\s\S]*?(?=(\n\s*(?:#{1,3}\s+)?[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s_]{2,}(?::|\s*\n)|$))/gi;

    if (plansSectionRegex.test(currentPrompt)) {
        let firstReplaced = false;
        const cleanedPrompt = currentPrompt.replace(plansSectionRegex, (match) => {
            if (!firstReplaced) {
                firstReplaced = true;
                const hasLeadingNewline = match.startsWith('\n');
                return `${hasLeadingNewline ? '\n\n' : ''}${trimmedBlock}`;
            }
            // Eliminar ocurrencias duplicadas subsecuentes
            return '';
        });

        return cleanedPrompt.trim();
    }

    // Si no existía ninguna sección de planes previa, concatenar al final
    return `${currentPrompt.trim()}\n\n${trimmedBlock}`.trim();
}

