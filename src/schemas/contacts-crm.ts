import { z } from 'zod';
import { ALL_CONTACT_PIPELINE_STAGES, ALL_CONTACT_ADDRESS_TYPES } from '../types/contact-enums.js';
import { APPOINTMENT_STATUSES } from '../types/appointment-status.js';
import { DEAL_CURRENCIES } from '../types/deal-currency.js';

/**
 * Esquemas Zod de `routes/contacts-crm.ts` (Fase D, docs/tasks/opus.md).
 * Mismo estilo que `src/schemas/contacts.ts`/`organization-onboarding.ts`.
 */
export const orgContactParamsSchema = z.object({
    id: z.string().uuid(),
    contactId: z.string().uuid(),
});
export type OrgContactParams = z.infer<typeof orgContactParamsSchema>;

export const orgContactAddressParamsSchema = orgContactParamsSchema.extend({
    addressId: z.string().uuid(),
});
export type OrgContactAddressParams = z.infer<typeof orgContactAddressParamsSchema>;

export const orgAppointmentParamsSchema = z.object({
    id: z.string().uuid(),
    appointmentId: z.string().uuid(),
});
export type OrgAppointmentParams = z.infer<typeof orgAppointmentParamsSchema>;

export const orgIdParamsSchema = z.object({
    id: z.string().uuid(),
});

// --- PATCH .../contacts/:contactId ---------------------------------------
export const contactUpdateBodySchema = z
    .object({
        fullName: z.string().min(1).nullable().optional(),
        email: z.string().email().nullable().optional(),
        businessName: z.string().min(1).nullable().optional(),
        businessSector: z.string().min(1).nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'Debe incluir al menos un campo a actualizar.' });
export type ContactUpdateBody = z.infer<typeof contactUpdateBodySchema>;

// --- PATCH .../contacts/:contactId/pipeline ------------------------------
export const contactPipelineUpdateBodySchema = z.object({
    pipelineStage: z.enum(ALL_CONTACT_PIPELINE_STAGES as unknown as [string, ...string[]]),
    wonAt: z.string().datetime().optional(),
    lostReason: z.string().min(1).optional(),
    // Valor de cierre (C.1, docs/tasks/asistencia-valor de cierre.md) — solo
    // tiene efecto cuando pipelineStage === 'ganado'; el monto sigue siendo
    // opcional, un cierre sin monto sigue siendo un cierre.
    dealValue: z.number().min(0).optional(),
    dealCurrency: z.enum([DEAL_CURRENCIES.MXN, DEAL_CURRENCIES.USD]).optional(),
    dealNotes: z.string().max(2000).optional(),
});
export type ContactPipelineUpdateBody = z.infer<typeof contactPipelineUpdateBodySchema>;

// --- POST .../contacts/:contactId/notes ----------------------------------
export const contactNoteBodySchema = z.object({
    body: z.string().min(1),
});
export type ContactNoteBody = z.infer<typeof contactNoteBodySchema>;

// --- POST/PATCH .../contacts/:contactId/addresses ------------------------
export const contactAddressBodySchema = z.object({
    street: z.string().min(1),
    label: z.string().min(1).nullable().optional(),
    addressType: z.enum(ALL_CONTACT_ADDRESS_TYPES as unknown as [string, ...string[]]).optional(),
    city: z.string().min(1).nullable().optional(),
    state: z.string().min(1).nullable().optional(),
    postalCode: z.string().min(1).nullable().optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
});
export type ContactAddressBody = z.infer<typeof contactAddressBodySchema>;

export const contactAddressUpdateBodySchema = z
    .object({
        street: z.string().min(1).optional(),
        label: z.string().min(1).nullable().optional(),
        addressType: z.enum(ALL_CONTACT_ADDRESS_TYPES as unknown as [string, ...string[]]).optional(),
        city: z.string().min(1).nullable().optional(),
        state: z.string().min(1).nullable().optional(),
        postalCode: z.string().min(1).nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        isPrimary: z.boolean().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, { message: 'Debe incluir al menos un campo a actualizar.' });
export type ContactAddressUpdateBody = z.infer<typeof contactAddressUpdateBodySchema>;

// --- PATCH .../appointments/:appointmentId/status ------------------------
// Vocabulario alineado con appointments_status_check (db/migrations/39_resultado_negocio.sql)
// vía src/types/appointment-status.ts — única fuente de verdad, no un array local.
export const appointmentStatusUpdateBodySchema = z.object({
    status: z.enum([
        APPOINTMENT_STATUSES.PROGRAMADA,
        APPOINTMENT_STATUSES.CONFIRMADA,
        APPOINTMENT_STATUSES.COMPLETADA,
        APPOINTMENT_STATUSES.NO_ASISTIO,
        APPOINTMENT_STATUSES.CANCELADA,
        APPOINTMENT_STATUSES.REPROGRAMADA,
    ]),
    // Solo tiene efecto cuando status === 'no_asistio' (docs/tasks/asistencia-valor
    // de cierre.md, B.1) — el handler la ignora en cualquier otro caso.
    noShowReason: z.string().min(1).max(500).optional(),
});
export type AppointmentStatusUpdateBody = z.infer<typeof appointmentStatusUpdateBodySchema>;

// --- POST .../contacts/merge ----------------------------------------------
export const contactMergeBodySchema = z
    .object({
        keepContactId: z.string().uuid(),
        absorbContactId: z.string().uuid(),
    })
    .refine((body) => body.keepContactId !== body.absorbContactId, { message: 'keepContactId y absorbContactId deben ser distintos.' });
export type ContactMergeBody = z.infer<typeof contactMergeBodySchema>;
