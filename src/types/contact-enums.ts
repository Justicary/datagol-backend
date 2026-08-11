/**
 * Valores permitidos por los CHECK constraints de `contacts.lifecycle_stage`,
 * `contacts.pipeline_stage` y `contact_addresses.address_type`. Única fuente
 * de verdad: ningún literal de estos campos debe escribirse en otro lugar
 * del código. Verificado por inserción directa contra la base real — ver
 * __tests__/contact-enums.test.ts.
 *
 * La migración que agregó estas columnas/constraints se aplicó directamente
 * contra producción y no tiene un archivo correspondiente en
 * db/migrations/ (verificado: no hay ningún archivo que mencione
 * lifecycle_stage/contact_addresses/resolve_contact). Este módulo documenta
 * el comportamiento real observado contra la base — no un diseño asumido.
 */
export const CONTACT_LIFECYCLE_STAGES = {
    PROSPECTO: 'prospecto',
    CLIENTE: 'cliente',
    DESCARTADO: 'descartado',
} as const;

export type ContactLifecycleStage = (typeof CONTACT_LIFECYCLE_STAGES)[keyof typeof CONTACT_LIFECYCLE_STAGES];

export const ALL_CONTACT_LIFECYCLE_STAGES: readonly ContactLifecycleStage[] = Object.values(CONTACT_LIFECYCLE_STAGES);

export function isContactLifecycleStage(value: string): value is ContactLifecycleStage {
    return (ALL_CONTACT_LIFECYCLE_STAGES as readonly string[]).includes(value);
}

export const CONTACT_PIPELINE_STAGES = {
    NUEVO: 'nuevo',
    CONTACTADO: 'contactado',
    CALIFICADO: 'calificado',
    CITA_AGENDADA: 'cita_agendada',
    GANADO: 'ganado',
    PERDIDO: 'perdido',
} as const;

export type ContactPipelineStage = (typeof CONTACT_PIPELINE_STAGES)[keyof typeof CONTACT_PIPELINE_STAGES];

export const ALL_CONTACT_PIPELINE_STAGES: readonly ContactPipelineStage[] = Object.values(CONTACT_PIPELINE_STAGES);

export function isContactPipelineStage(value: string): value is ContactPipelineStage {
    return (ALL_CONTACT_PIPELINE_STAGES as readonly string[]).includes(value);
}

export const CONTACT_ADDRESS_TYPES = {
    MATRIZ: 'matriz',
    SUCURSAL: 'sucursal',
    FACTURACION: 'facturacion',
    DOMICILIO: 'domicilio',
    SERVICIO: 'servicio',
} as const;

export type ContactAddressType = (typeof CONTACT_ADDRESS_TYPES)[keyof typeof CONTACT_ADDRESS_TYPES];

export const ALL_CONTACT_ADDRESS_TYPES: readonly ContactAddressType[] = Object.values(CONTACT_ADDRESS_TYPES);

export function isContactAddressType(value: string): value is ContactAddressType {
    return (ALL_CONTACT_ADDRESS_TYPES as readonly string[]).includes(value);
}

/**
 * Constraint `contacts_lifecycle_pipeline_coherent`, verificada contra la
 * base real con las 18 combinaciones posibles (3 lifecycle × 6 pipeline):
 *
 *   - `cliente`    únicamente coherente con `pipeline_stage = 'ganado'`.
 *   - `prospecto`  coherente con cualquier pipeline_stage EXCEPTO `ganado`.
 *   - `descartado` coherente con cualquier pipeline_stage (incluido
 *     `ganado`: un cliente que se da de baja se marca `descartado` sin perder
 *     el hecho de que en algún momento ganó).
 *
 * El CHECK de la base es la autoridad real; esta función solo evita que el
 * servidor intente un UPDATE que sabemos de antemano que la base va a
 * rechazar, para devolver un 400 con mensaje claro en vez de un 500 genérico
 * envuelto en el error de Postgres.
 */
export function isLifecyclePipelineCoherent(lifecycleStage: string, pipelineStage: string): boolean {
    if (lifecycleStage === CONTACT_LIFECYCLE_STAGES.CLIENTE) {
        return pipelineStage === CONTACT_PIPELINE_STAGES.GANADO;
    }
    if (lifecycleStage === CONTACT_LIFECYCLE_STAGES.PROSPECTO) {
        return pipelineStage !== CONTACT_PIPELINE_STAGES.GANADO;
    }
    return lifecycleStage === CONTACT_LIFECYCLE_STAGES.DESCARTADO;
}
