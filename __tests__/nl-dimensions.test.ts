import { describe, it, expect } from 'vitest';
import {
    resolvePeriod,
    getZonedDateParts,
    zonedDateTimeToUtc,
    isValidTimezone,
    DEFAULT_TIMEZONE,
} from '../src/services/reports/nl-dimensions.js';
import { NL_PERIOD_TYPES, NL_COMPARE_TO_DIMENSIONS } from '../src/types/natural-reports.js';

describe('services/reports/nl-dimensions.ts', () => {
    // Fecha de prueba fija: 2026-08-18 (martes) a las 14:30:00 UTC
    // En America/Mexico_City (UTC-6) es 2026-08-18 08:30:00
    const fixedNowUtc = new Date(Date.UTC(2026, 7, 18, 14, 30, 0));

    it('valida zonas horarias correctamente', () => {
        expect(isValidTimezone('America/Mexico_City')).toBe(true);
        expect(isValidTimezone('America/Tijuana')).toBe(true);
        expect(isValidTimezone('Europe/Madrid')).toBe(true);
        expect(isValidTimezone('Zona/Invalida')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
    });

    it('extrae las partes de fecha local en la zona horaria indicada', () => {
        const parts = getZonedDateParts(fixedNowUtc, 'America/Mexico_City');
        expect(parts.year).toBe(2026);
        expect(parts.month).toBe(8);
        expect(parts.day).toBe(18);
        expect(parts.hour).toBe(8);
        expect(parts.minute).toBe(30);
    });

    it('convierte hora local a UTC respetando el offset de la zona horaria', () => {
        // En America/Mexico_City (UTC-6 en 2026), las 00:00:00 local son las 06:00:00 UTC
        const utcDate = zonedDateTimeToUtc(2026, 8, 18, 0, 0, 0, 0, 'America/Mexico_City');
        expect(utcDate.toISOString()).toBe('2026-08-18T06:00:00.000Z');
    });

    it('resuelve el periodo "hoy" con límites exactos en zona horaria local', () => {
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.HOY }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('hoy');
        expect(period.startLocal).toBe('2026-08-18');
        expect(period.endLocal).toBe('2026-08-18');
        expect(period.startUtc).toBe('2026-08-18T06:00:00.000Z');
        expect(period.endUtc).toBe('2026-08-19T05:59:59.999Z');
        expect(period.label).toContain('Hoy');
    });

    it('resuelve el periodo "ayer" correctamente', () => {
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.AYER }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('ayer');
        expect(period.startLocal).toBe('2026-08-17');
        expect(period.endLocal).toBe('2026-08-17');
        expect(period.startUtc).toBe('2026-08-17T06:00:00.000Z');
        expect(period.label).toContain('Ayer');
    });

    it('resuelve el periodo "esta_semana" de lunes a domingo', () => {
        // 2026-08-18 es martes -> el lunes fue 17 y el domingo es 23
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.ESTA_SEMANA }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('esta_semana');
        expect(period.startLocal).toBe('2026-08-17');
        expect(period.endLocal).toBe('2026-08-23');
        expect(period.startUtc).toBe('2026-08-17T06:00:00.000Z');
        expect(period.label).toContain('Esta semana');
    });

    it('resuelve el periodo "semana_pasada" correctamente', () => {
        // La semana pasada fue del lunes 10 al domingo 16 de agosto
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.SEMANA_PASADA }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('semana_pasada');
        expect(period.startLocal).toBe('2026-08-10');
        expect(period.endLocal).toBe('2026-08-16');
        expect(period.startUtc).toBe('2026-08-10T06:00:00.000Z');
        expect(period.label).toContain('Semana pasada');
    });

    it('resuelve el periodo "este_mes" para todo agosto 2026', () => {
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.ESTE_MES }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('este_mes');
        expect(period.startLocal).toBe('2026-08-01');
        expect(period.endLocal).toBe('2026-08-31');
        expect(period.startUtc).toBe('2026-08-01T06:00:00.000Z');
        expect(period.label).toContain('Este mes');
    });

    it('resuelve el periodo "mes_pasado" para todo julio 2026', () => {
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.MES_PASADO }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('mes_pasado');
        expect(period.startLocal).toBe('2026-07-01');
        expect(period.endLocal).toBe('2026-07-31');
        expect(period.startUtc).toBe('2026-07-01T06:00:00.000Z');
        expect(period.label).toContain('Mes pasado');
    });

    it('resuelve "ultimos_n_dias" correctamente con N=7', () => {
        const period = resolvePeriod({ type: NL_PERIOD_TYPES.ULTIMOS_N_DIAS, n: 7 }, 'America/Mexico_City', { now: fixedNowUtc });
        expect(period.type).toBe('ultimos_n_dias');
        expect(period.startLocal).toBe('2026-08-12');
        expect(period.endLocal).toBe('2026-08-18');
        expect(period.label).toContain('Últimos 7 días');
    });

    it('resuelve "rango_explicito" con inicio y fin personalizados', () => {
        const period = resolvePeriod(
            { type: NL_PERIOD_TYPES.RANGO_EXPLICITO, inicio: '2026-05-01', fin: '2026-05-15' },
            'America/Mexico_City',
            { now: fixedNowUtc }
        );
        expect(period.type).toBe('rango_explicito');
        expect(period.startLocal).toBe('2026-05-01');
        expect(period.endLocal).toBe('2026-05-15');
        expect(period.startUtc).toBe('2026-05-01T06:00:00.000Z');
    });

    it('resuelve comparaciones temporales (periodo_anterior y mismo_periodo_mes_pasado)', () => {
        const periodAnterior = resolvePeriod(
            { type: NL_PERIOD_TYPES.HOY },
            'America/Mexico_City',
            { now: fixedNowUtc, compareTo: NL_COMPARE_TO_DIMENSIONS.PERIODO_ANTERIOR }
        );
        expect(periodAnterior.previousPeriod).toBeDefined();
        expect(periodAnterior.previousPeriod?.label).toContain('Periodo inmediatamente anterior');

        const periodMesPasado = resolvePeriod(
            { type: NL_PERIOD_TYPES.ESTE_MES },
            'America/Mexico_City',
            { now: fixedNowUtc, compareTo: NL_COMPARE_TO_DIMENSIONS.MISMO_PERIODO_MES_PASADO }
        );
        expect(periodMesPasado.previousPeriod).toBeDefined();
        expect(periodMesPasado.previousPeriod?.label).toContain('julio 2026');
    });
});
