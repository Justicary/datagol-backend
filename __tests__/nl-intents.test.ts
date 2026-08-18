import { describe, it, expect, vi } from 'vitest';
import { ALL_INTENTS, getIntentByKey } from '../src/services/reports/intents/index.js';
import { ALL_NL_INTENT_KEYS } from '../src/types/natural-reports.js';
import { resolvePeriod } from '../src/services/reports/nl-dimensions.js';
import { FastifyInstance } from 'fastify';

describe('Catálogo de 18 Intenciones de Reportes en Lenguaje Natural', () => {
    it('registra exactamente las 18 intenciones exigidas por la v1', () => {
        expect(ALL_INTENTS).toHaveLength(18);
        for (const key of ALL_NL_INTENT_KEYS) {
            const intent = getIntentByKey(key);
            expect(intent).toBeDefined();
            expect(intent?.key).toBe(key);
            expect(intent?.description).toBeTruthy();
            expect(intent?.examples.length).toBeGreaterThanOrEqual(3);
            expect(['numero', 'tabla', 'lista']).toContain(intent?.resultShape);
            expect(intent?.parametersSchema).toBeDefined();
        }
    });

    it('todas las intenciones tienen ejemplos válidos y no vacíos', () => {
        for (const intent of ALL_INTENTS) {
            for (const example of intent.examples) {
                expect(typeof example).toBe('string');
                expect(example.trim().length).toBeGreaterThan(5);
            }
        }
    });
});

describe('Ejecución de intenciones con consultas parametrizadas', () => {
    const fixedNow = new Date('2026-08-18T12:00:00.000Z');
    const period = resolvePeriod({ type: 'este_mes' }, 'America/Mexico_City', { now: fixedNow });
    const orgId = 'org-123-uuid';

    function buildMockFastify(mockQueryData: any = [], count: number | null = null): FastifyInstance {
        const queryBuilder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            lt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockImplementation(() => Promise.resolve({ data: mockQueryData, error: null })),
            then: vi.fn().mockImplementation((onfulfilled) =>
                Promise.resolve(onfulfilled({ data: mockQueryData, count, error: null }))
            ),
        };

        return {
            log: {
                error: vi.fn(),
                warn: vi.fn(),
                info: vi.fn(),
            },
            supabaseAdmin: {
                from: vi.fn().mockReturnValue(queryBuilder),
            },
        } as unknown as FastifyInstance;
    }

    // 1. listado_citas
    it('ejecuta listado_citas correctamente', async () => {
        const intent = getIntentByKey('listado_citas')!;
        const fastify = buildMockFastify([
            { id: '1', customer_name: 'Juan Pérez', customer_phone: '+525512345678', start_time: '2026-08-18T10:00:00Z', status: 'confirmada', service_address: 'Av Reforma' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('lista');
        expect(result.data).toHaveLength(1);
        expect((result.data as any)[0].customer_name).toBe('Juan Pérez');
    });

    // 2. conteo_citas
    it('ejecuta conteo_citas correctamente', async () => {
        const intent = getIntentByKey('conteo_citas')!;
        const fastify = buildMockFastify([], 15);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).total).toBe(15);
        expect(result.warnings[0]).toContain('Muestra pequeña');
    });

    // 3. citas_por_estado
    it('ejecuta citas_por_estado agrupando correctamente los estados canónicos', async () => {
        const intent = getIntentByKey('citas_por_estado')!;
        const fastify = buildMockFastify([
            { status: 'confirmada' },
            { status: 'confirmada' },
            { status: 'completada' },
            { status: 'no_asistio' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).totalGeneral).toBe(4);
        const confirmadas = (result.data as any).filas.find((f: any) => f.estado === 'confirmada');
        expect(confirmadas?.total).toBe(2);
        expect(confirmadas?.porcentaje).toBe(50);
    });

    // 4. citas_sin_desenlace
    it('ejecuta citas_sin_desenlace incluyendo advertencia de actualización', async () => {
        const intent = getIntentByKey('citas_sin_desenlace')!;
        const fastify = buildMockFastify([
            { id: 'c-1', customer_name: 'Ana', start_time: '2026-08-10T10:00:00Z', status: 'programada' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('lista');
        expect(result.warnings[0]).toContain('fundamental registrar el desenlace');
    });

    // 5. pendientes_abiertos
    it('ejecuta pendientes_abiertos listando contactos en pipeline abierto', async () => {
        const intent = getIntentByKey('pendientes_abiertos')!;
        const fastify = buildMockFastify([
            { id: 'ct-1', first_name: 'Carlos', lifecycle_stage: 'lead' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('lista');
        expect((result.data as any)[0].first_name).toBe('Carlos');
    });

    // 6. seguimientos_vencidos
    it('ejecuta seguimientos_vencidos sumando citas pasadas y prospectos estancados', async () => {
        const intent = getIntentByKey('seguimientos_vencidos')!;
        const fastify = buildMockFastify([], 3);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).totalVencidos).toBe(6); // 3 citas + 3 prospectos mock
    });

    // 7. prospectos_calientes_sin_atender
    it('ejecuta prospectos_calientes_sin_atender declarando los nulos', async () => {
        const intent = getIntentByKey('prospectos_calientes_sin_atender')!;
        const fastify = buildMockFastify(
            [{ id: 'l-1', customer_name: 'Pedro', temperature: 'caliente', booked_appointment: false }],
            5
        );

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('lista');
        expect((result.data as any).totalCalientesSinCita).toBe(1);
        expect((result.data as any).totalSinClasificar).toBe(5);
        expect(result.warnings[0]).toContain('conversaciones históricas sin clasificación de temperatura');
    });

    // 8. conteo_prospectos_nuevos
    it('ejecuta conteo_prospectos_nuevos contra tabla contacts', async () => {
        const intent = getIntentByKey('conteo_prospectos_nuevos')!;
        const fastify = buildMockFastify([], 42);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).totalProspectosNuevos).toBe(42);
    });

    // 9. listado_prospectos
    it('ejecuta listado_prospectos devolviendo lista detallada', async () => {
        const intent = getIntentByKey('listado_prospectos')!;
        const fastify = buildMockFastify([
            { id: 'ct-2', first_name: 'Elena', phone: '+525599887766', lifecycle_stage: 'lead' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('lista');
        expect((result.data as any)[0].first_name).toBe('Elena');
    });

    // 10. conteo_conversaciones
    it('ejecuta conteo_conversaciones contra tabla leads', async () => {
        const intent = getIntentByKey('conteo_conversaciones')!;
        const fastify = buildMockFastify([], 88);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).totalConversaciones).toBe(88);
    });

    // 11. atribucion_origen
    it('ejecuta atribucion_origen declarando "sin_dato" en registros sin fuente', async () => {
        const intent = getIntentByKey('atribucion_origen')!;
        const fastify = buildMockFastify([
            { source: 'anuncio_pagado', booked_appointment: true, contact_id: 'c1' },
            { source: 'anuncio_pagado', booked_appointment: false, contact_id: 'c2' },
            { source: null, booked_appointment: false, contact_id: 'c3' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).totalConversaciones).toBe(3);
        expect((result.data as any).totalSinDato).toBe(1);
        const sinDatoRow = (result.data as any).filas.find((f: any) => f.origen === 'sin_dato');
        expect(sinDatoRow?.totalConversaciones).toBe(1);
    });

    // 12. costo_total
    it('ejecuta costo_total sumando compensaciones negativas', async () => {
        const intent = getIntentByKey('costo_total')!;
        const fastify = buildMockFastify([
            { amount_usd: '10.50' },
            { amount_usd: '5.25' },
            { amount_usd: '-2.00' }, // compensación negativa
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).costoTotalUsd).toBe(13.75);
    });

    // 13. costo_por_canal
    it('ejecuta costo_por_canal agrupando por proveedor', async () => {
        const intent = getIntentByKey('costo_por_canal')!;
        const fastify = buildMockFastify([
            { provider: 'elevenlabs', amount_usd: '20.00', quantity: 100 },
            { provider: 'telnyx', amount_usd: '5.00', quantity: 50 },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).costoTotalUsd).toBe(25.00);
        expect((result.data as any).filas[0].proveedor).toBe('elevenlabs');
        expect((result.data as any).filas[0].porcentaje).toBe(80);
    });

    // 14. costo_por_prospecto
    it('ejecuta costo_por_prospecto calculando CAC con denominador explícito', async () => {
        const intent = getIntentByKey('costo_por_prospecto')!;
        const fastify = buildMockFastify([
            { amount_usd: '100.00' },
        ], 10); // 10 contactos

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).costoPorProspectoUsd).toBe(10);
        expect(result.warnings[0]).toContain('denominador de 10 prospectos');
    });

    // 15. costo_por_cita
    it('ejecuta costo_por_cita calculando costo por agendamiento con denominador', async () => {
        const intent = getIntentByKey('costo_por_cita')!;
        const fastify = buildMockFastify([
            { amount_usd: '150.00' },
        ], 5); // 5 citas

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('numero');
        expect((result.data as any).costoPorCitaUsd).toBe(30);
        expect(result.warnings[0]).toContain('denominador de 5 citas');
    });

    // 16. resultado_negocio
    it('ejecuta resultado_negocio calculando total y ticket sobre cierres con monto', async () => {
        const intent = getIntentByKey('resultado_negocio')!;
        const fastify = buildMockFastify([
            { deal_value: '5000.00', deal_currency: 'MXN', won_at: '2026-08-05' },
            { deal_value: '3000.00', deal_currency: 'MXN', won_at: '2026-08-10' },
            { deal_value: null, deal_currency: 'MXN', won_at: '2026-08-12' }, // cierre sin monto
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).clientesCerrados).toBe(3);
        expect((result.data as any).cierresConMonto).toBe(2);
        expect((result.data as any).valorTotalVendido).toBe(8000);
        expect((result.data as any).ticketPromedio).toBe(4000);
        expect(result.warnings[0]).toContain('calculadas sobre 2 de 3 clientes cerrados');
    });

    // 17. cumplimiento_citas
    it('ejecuta cumplimiento_citas calculando tasa de asistencia y citas sin marcar', async () => {
        const intent = getIntentByKey('cumplimiento_citas')!;
        const fastify = buildMockFastify([
            { status: 'completada', start_time: '2026-08-01T10:00:00Z' },
            { status: 'completada', start_time: '2026-08-02T10:00:00Z' },
            { status: 'no_asistio', start_time: '2026-08-03T10:00:00Z' },
            { status: 'cancelada', start_time: '2026-08-04T10:00:00Z' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).asistieron).toBe(2);
        expect((result.data as any).noAsistieron).toBe(1);
        expect((result.data as any).tasaAsistencia).toBe(66.7);
    });

    // 18. tasa_conversion
    it('ejecuta tasa_conversion con métricas de embudo y denominadores', async () => {
        const intent = getIntentByKey('tasa_conversion')!;
        const fastify = buildMockFastify([
            { booked_appointment: true, lifecycle_stage: 'cliente' },
            { booked_appointment: false, lifecycle_stage: 'lead' },
        ]);

        const result = await intent.execute(fastify, orgId, {}, period);
        expect(result.shape).toBe('tabla');
        expect((result.data as any).tasaConversacionACita).toBe(50);
        expect((result.data as any).tasaProspectoACliente).toBe(50);
    });
});
