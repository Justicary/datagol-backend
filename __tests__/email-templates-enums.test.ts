import { describe, it, expect } from 'vitest';
import {
    EMAIL_TEMPLATES,
    ALL_EMAIL_TEMPLATES,
    isEmailTemplateId,
    EMAIL_TYPES,
    ALL_EMAIL_TYPES,
    isEmailTypeId,
} from '../src/types/email-templates.js';

describe('email-templates constants and enums', () => {
    it('contiene exactamente las 5 plantillas especificadas en el contrato', () => {
        expect(EMAIL_TEMPLATES).toEqual({
            PROFESIONAL: 'profesional',
            MINIMALISTA: 'minimalista',
            CORPORATIVO: 'corporativo',
            CALIDO: 'calido',
            COMPACTO: 'compacto',
        });
        expect(ALL_EMAIL_TEMPLATES).toHaveLength(5);
    });

    it('isEmailTemplateId valida las 5 plantillas y rechaza valores inválidos', () => {
        expect(isEmailTemplateId('profesional')).toBe(true);
        expect(isEmailTemplateId('minimalista')).toBe(true);
        expect(isEmailTemplateId('corporativo')).toBe(true);
        expect(isEmailTemplateId('calido')).toBe(true);
        expect(isEmailTemplateId('compacto')).toBe(true);

        expect(isEmailTemplateId('invalido')).toBe(false);
        expect(isEmailTemplateId('')).toBe(false);
        expect(isEmailTemplateId('PROFESIONAL')).toBe(false);
    });

    it('contiene los tipos de correo soportados y valida con isEmailTypeId', () => {
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.CALL_SUMMARY);
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.HOT_LEAD);
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.APPOINTMENT_CONFIRMATION);
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.PROSPECT_SUMMARY);
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.CREDITS_ALERT);
        expect(ALL_EMAIL_TYPES).toContain(EMAIL_TYPES.THANK_YOU);

        expect(isEmailTypeId('call_summary')).toBe(true);
        expect(isEmailTypeId('hot_lead')).toBe(true);
        expect(isEmailTypeId('appointment_confirmation')).toBe(true);
        expect(isEmailTypeId('prospect_summary')).toBe(true);
        expect(isEmailTypeId('credits_alert')).toBe(true);
        expect(isEmailTypeId('thank_you')).toBe(true);

        expect(isEmailTypeId('unknown_type')).toBe(false);
        expect(isEmailTypeId('')).toBe(false);
    });
});
