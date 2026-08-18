import { describe, it, expect, vi } from 'vitest';
import { resolvePeriod } from '../src/services/reports/nl-dimensions.js';
import { executeIntent } from '../src/services/reports/nl-execution-service.js';
import { verifyNarrativeNumbers } from '../src/services/reports/nl-narrative-service.js';
import { FastifyInstance } from 'fastify';

describe('Pruebas Específicas de Validación de Trampas del Esquema (docs/tasks/reportes-lenguaje-natural.md)', () => {
    const orgId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const tz = 'America/Mexico_City';
    const period = resolvePeriod({ type: 'este_mes' }, tz, { now: new Date('2026-08-18T12:00:00Z') });

    function buildMockFastify(mockQueryData: any = [], count: number | null = null, onFrom?: (table: string) => void): FastifyInstance {
        const queryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => Promise.resolve({ data: mockQueryData, count: count ?? mockQueryData.length, error: null })),
            then: vi.fn().mockImplementation((onfulfilled) =>
                Promise.resolve(onfulfilled({ data: mockQueryData, count: count ?? mockQueryData.length, error: null }))
            ),
        };

        return {
            log: {
                error: vi.fn(),
                warn: vi.fn(),
                info: vi.fn(),
            },
            supabaseAdmin: {
                from: vi.fn().mockImplementation((table: string) => {
                    if (onFrom) onFrom(table);
                    return queryBuilder;
                }),
            },
        } as unknown as FastifyInstance;
    }

    it('Trampa 1: contacts vs leads — conteo_prospectos_nuevos consulta contacts y conteo_conversaciones consulta leads', async () => {
        const calledTables: string[] = [];
        const mockFastify = buildMockFastify([], 15, (table) => calledTables.push(table));

        // Conteo de prospectos consulta 'contacts'
        const resProspectos = await executeIntent(mockFastify, orgId, {
            intent: 'conteo_prospectos_nuevos',
            parameters: {},
            period,
        });
        expect(calledTables).toContain('contacts');
        expect((resProspectos.data as any).totalProspectosNuevos).toBe(15);

        calledTables.length = 0;
        // Conteo de conversaciones consulta 'leads'
        const resConversaciones = await executeIntent(mockFastify, orgId, {
            intent: 'conteo_conversaciones',
            parameters: {},
            period,
        });
        expect(calledTables).toContain('leads');
    });

    it('Trampa 2: contacts.temperature nullable — prospectos_calientes_sin_atender declara totalSinClasificar en advertencia', async () => {
        const mockData = [
            { id: 'c1', customer_name: 'Ana', customer_phone: '+521', temperature: 'caliente', created_at: '2026-08-01', booked_appointment: false },
        ];
        const mockFastify = buildMockFastify(mockData, 2);

        const res = await executeIntent(mockFastify, orgId, {
            intent: 'prospectos_calientes_sin_atender',
            parameters: {},
            period,
        });
        expect((res.data as any).totalCalientesSinCita).toBe(1);
        expect((res.data as any).totalSinClasificar).toBe(2);
        expect(res.warnings.some((w) => w.includes('2 conversaciones históricas sin clasificación'))).toBe(true);
    });

    it('Trampa 3: usage_events tiene compensaciones negativas — costo_total suma amount_usd sin filtrar > 0', async () => {
        const mockData = [
            { amount_usd: '10.50', provider: 'elevenlabs' },
            { amount_usd: '5.00', provider: 'telnyx' },
            { amount_usd: '-2.50', provider: 'elevenlabs' }, // Compensación
        ];
        const mockFastify = buildMockFastify(mockData);

        const res = await executeIntent(mockFastify, orgId, {
            intent: 'costo_total',
            parameters: {},
            period,
        });
        expect((res.data as any).costoTotalUsd).toBe(13); // 10.50 + 5.00 - 2.50 = 13.00
    });

    it('Trampa 4: Citas sin desenlace — citas pasadas en estado programada o confirmada son alertadas', async () => {
        const mockData = [
            { id: 'a1', start_time: '2026-08-10T10:00:00Z', status: 'confirmada', contact_id: 'c1' },
            { id: 'a2', start_time: '2026-08-11T12:00:00Z', status: 'programada', contact_id: 'c2' },
        ];
        const mockFastify = buildMockFastify(mockData, 2);

        const res = await executeIntent(mockFastify, orgId, {
            intent: 'citas_sin_desenlace',
            parameters: {},
            period,
        });
        expect(Array.isArray(res.data)).toBe(true);
        expect((res.data as any).length).toBe(2);
        expect(res.summaryMetrics?.totalSinDesenlace).toBe(2);
        expect(res.warnings.some((w) => w.includes('desenlace'))).toBe(true);
    });

    it('Trampa 5: resultado_negocio solo suma deal_value de contactos ganados con monto', async () => {
        const mockData = [
            { deal_value: '5000.00', deal_currency: 'MXN', won_at: '2026-08-10T10:00:00Z', lifecycle_stage: 'cliente' },
            { deal_value: '3000.00', deal_currency: 'MXN', won_at: '2026-08-11T10:00:00Z', lifecycle_stage: 'cliente' },
            { deal_value: null, deal_currency: 'MXN', won_at: '2026-08-12T10:00:00Z', lifecycle_stage: 'cliente' },
        ];
        const mockFastify = buildMockFastify(mockData);

        const res = await executeIntent(mockFastify, orgId, {
            intent: 'resultado_negocio',
            parameters: {},
            period,
        });
        expect((res.data as any).valorTotalVendido).toBe(8000);
        expect((res.data as any).clientesCerrados).toBe(3);
        expect((res.data as any).cierresConMonto).toBe(2);
        expect((res.data as any).ticketPromedio).toBe(4000);
        expect(res.warnings.some((w) => w.includes('1 clientes marcados como ganados sin valor'))).toBe(true);
    });

    it('Trampa 6: Medianoche local vs UTC en resolución de periodos', () => {
        // En CDMX (UTC-6), el 2026-08-18 inicia a las 06:00:00 UTC y termina a las 05:59:59.999Z del día siguiente
        const todayPeriod = resolvePeriod({ type: 'hoy' }, 'America/Mexico_City', { now: new Date('2026-08-18T18:00:00Z') });
        expect(todayPeriod.startUtc).toBe('2026-08-18T06:00:00.000Z');
        expect(todayPeriod.endUtc).toBe('2026-08-19T05:59:59.999Z');
    });

    it('Trampa 7: Anti-alucinación numérica — rechaza narrativa con números no presentes en datos', () => {
        const rawData = { total: 10, costo: 500 };
        const valid = verifyNarrativeNumbers('Tuviste 10 prospectos con un costo de $500.', rawData);
        expect(valid.ok).toBe(true);

        const invalid = verifyNarrativeNumbers('Tuviste 10 prospectos con un costo de $500 y 99 llamadas perdidas.', rawData);
        expect(invalid.ok).toBe(false);
        expect(invalid.unmatched).toContain(99);
    });
});
