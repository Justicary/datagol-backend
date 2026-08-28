import { describe, it, expect } from 'vitest';
import {
    numberToSpanishWords,
    generatePlansPromptBlock,
    injectPlansSectionIntoPrompt,
    type PlanDataForPrompt,
    DEFAULT_PLANS_SALES_DIRECTIVE,
} from '../src/services/plans-prompt-formatter.js';

describe('plans-prompt-formatter', () => {
    describe('numberToSpanishWords', () => {
        it('convierte 0 y números básicos correctamente', () => {
            expect(numberToSpanishWords(0)).toBe('cero');
            expect(numberToSpanishWords(1)).toBe('un');
            expect(numberToSpanishWords(5)).toBe('cinco');
            expect(numberToSpanishWords(15)).toBe('quince');
            expect(numberToSpanishWords(20)).toBe('veinte');
            expect(numberToSpanishWords(25)).toBe('veinticinco');
            expect(numberToSpanishWords(30)).toBe('treinta');
            expect(numberToSpanishWords(35)).toBe('treinta y cinco');
            expect(numberToSpanishWords(100)).toBe('cien');
            expect(numberToSpanishWords(105)).toBe('ciento cinco');
            expect(numberToSpanishWords(500)).toBe('quinientos');
            expect(numberToSpanishWords(999)).toBe('novecientos noventa y nueve');
            expect(numberToSpanishWords(1000)).toBe('mil');
        });

        it('convierte tarifas reales de Datagol con precisión fonética', () => {
            expect(numberToSpanishWords(7999)).toBe('siete mil novecientos noventa y nueve');
            expect(numberToSpanishWords(999)).toBe('novecientos noventa y nueve');
            expect(numberToSpanishWords(10999)).toBe('diez mil novecientos noventa y nueve');
            expect(numberToSpanishWords(2499)).toBe('dos mil cuatrocientos noventa y nueve');
            expect(numberToSpanishWords(28999)).toBe('veintiocho mil novecientos noventa y nueve');
            expect(numberToSpanishWords(8900)).toBe('ocho mil novecientos');
            expect(numberToSpanishWords(7900)).toBe('siete mil novecientos');
            expect(numberToSpanishWords(39900)).toBe('treinta y nueve mil novecientos');
            expect(numberToSpanishWords(50000)).toBe('cincuenta mil');
        });
    });

    describe('generatePlansPromptBlock', () => {
        const mockPlans: PlanDataForPrompt[] = [
            {
                key: 'starter',
                name: 'Starter 24/7',
                setupFeeMxn: 7999,
                monthlyFeeMxn: 999,
                isPopular: false,
                setupIncludes: ['Recepcionista Omnicanal 24/7', '365 minutos de llamadas', 'agendamiento en calendario'],
                showRetainer: true,
            },
            {
                key: 'pro',
                name: 'Pro Omnicanal',
                setupFeeMxn: 10999,
                monthlyFeeMxn: 2499,
                isPopular: true,
                badge: '★ MÁS POPULAR',
                setupIncludes: ['Todo lo anterior más consultas con IA', 'confirmación/cancelación de citas'],
                showRetainer: true,
            },
            {
                key: 'elite',
                name: 'Elite 360',
                setupFeeMxn: 28999,
                monthlyFeeMxn: 7900,
                isPopular: false,
                setupIncludes: ['Todo lo anterior más optimización de rutas', 'llamadas salientes'],
                showRetainer: true,
            },
            {
                key: 'enterprise',
                name: 'Enterprise',
                setupFeeMxn: 39900,
                monthlyFeeMxn: null,
                isPopular: false,
                badge: 'A MEDIDA',
                setupIncludes: ['Conmutadores multidepartamento/multiagente y marca blanca'],
                showRetainer: false,
            },
        ];

        it('genera la sección PLANES: completa y formateada', () => {
            const block = generatePlansPromptBlock(mockPlans);

            expect(block).toContain('PLANES:');
            expect(block).toContain('Starter 24/7 — instalación siete mil novecientos noventa y nueve pesos.');
            expect(block).toContain('Iguala opcional novecientos noventa y nueve pesos al mes.');
            expect(block).toContain('Pro Omnicanal, el más solicitado — instalación diez mil novecientos noventa y nueve pesos.');
            expect(block).toContain('Iguala opcional dos mil cuatrocientos noventa y nueve pesos al mes.');
            expect(block).toContain('Elite 360 — instalación veintiocho mil novecientos noventa y nueve pesos.');
            expect(block).toContain('Enterprise, a medida — desde treinta y nueve mil novecientos pesos.');
            expect(block).toContain(DEFAULT_PLANS_SALES_DIRECTIVE);
        });
    });

    describe('injectPlansSectionIntoPrompt', () => {
        const sampleBasePrompt = `Eres Paulina, la recepcionista ejecutiva de Datagol.

OBJETIVO:
Atender a los prospectos y responder preguntas sobre automatización de llamadas con IA.

PLANES:
Starter — instalación 7000 pesos. Versión vieja desactualizada.
Pro — instalación 10000 pesos.
Al hablar de precios, menciona un solo plan.

REGLAS DE CONVERSACIÓN:
- Sé amable y concisa.
- No interrumpas al usuario.`;

        const newBlock = `PLANES:
Starter 24/7 — instalación siete mil novecientos noventa y nueve pesos.
Pro Omnicanal, el más solicitado — instalación diez mil novecientos noventa y nueve pesos.
Al hablar de precios, menciona un solo plan a la vez.`;

        it('reemplaza la sección PLANES: existente conservando el resto del prompt', () => {
            const updated = injectPlansSectionIntoPrompt(sampleBasePrompt, newBlock);

            expect(updated).toContain('Eres Paulina, la recepcionista ejecutiva de Datagol.');
            expect(updated).toContain('Starter 24/7 — instalación siete mil novecientos noventa y nueve pesos.');
            expect(updated).not.toContain('Versión vieja desactualizada.');
            expect(updated).toContain('REGLAS DE CONVERSACIÓN:');
            expect(updated).toContain('- Sé amable y concisa.');
        });

        it('anexa la sección PLANES: si el prompt original no la tenía', () => {
            const promptWithoutPlans = `Eres Paulina, recepcionista de Datagol.\n\nREGLAS:\n- Habla en español.`;
            const updated = injectPlansSectionIntoPrompt(promptWithoutPlans, newBlock);

            expect(updated).toContain('Eres Paulina, recepcionista de Datagol.');
            expect(updated).toContain('PLANES:');
            expect(updated).toContain('Starter 24/7 — instalación siete mil novecientos noventa y nueve pesos.');
        });

        it('es idempotente al ejecutarse múltiples veces', () => {
            const first = injectPlansSectionIntoPrompt(sampleBasePrompt, newBlock);
            const second = injectPlansSectionIntoPrompt(first, newBlock);

            expect(second).toBe(first);
        });

        it('reemplaza correctamente cuando el encabezado PLANES no lleva dos puntos y la siguiente sección tampoco', () => {
            const promptNoColons = `QUÉ ES DATAGOL\nAgencia de IA.\n\nPLANES\n- Starter viejo.\n- Pro viejo.\n\nTU TRABAJO\n1. Atender llamadas.`;
            const updated = injectPlansSectionIntoPrompt(promptNoColons, newBlock);

            expect(updated).toContain('QUÉ ES DATAGOL\nAgencia de IA.');
            expect(updated).toContain(newBlock.trim());
            expect(updated).not.toContain('Starter viejo.');
            expect(updated).toContain('TU TRABAJO\n1. Atender llamadas.');
        });

        it('depura secciones duplicadas de PLANES si existían múltiples en el prompt', () => {
            const promptWithDuplicates = `QUÉ ES DATAGOL\nAgencia de IA.\n\nPLANES\n- Starter viejo.\n\nTU TRABAJO\n1. Atender llamadas.\n\nPLANES:\n- Starter duplicado.\n\nLÍMITES\nNo mentir.`;
            const updated = injectPlansSectionIntoPrompt(promptWithDuplicates, newBlock);

            expect(updated).toContain('QUÉ ES DATAGOL\nAgencia de IA.');
            expect(updated).toContain(newBlock.trim());
            expect(updated).not.toContain('Starter viejo.');
            expect(updated).not.toContain('Starter duplicado.');
            expect(updated).toContain('TU TRABAJO\n1. Atender llamadas.');
            expect(updated).toContain('LÍMITES\nNo mentir.');

            // Debe existir exactamente una sola ocurrencia de PLANES:
            const count = (updated.match(/PLANES:?/g) || []).length;
            expect(count).toBe(1);
        });
    });
});
