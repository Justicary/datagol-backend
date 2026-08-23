/**
 * Interpolación de variables de `send-template-email`
 * (docs/tasks/send-template-email-backend.md §"Campos del Request"):
 * `{primer_nombre}`, `{nombre_completo}`, `{empresa}`, `{mi_empresa}`.
 * Cualquier otra llave `{...}` no reconocida se deja intacta en el texto —
 * no se asume que todo `{` es una variable propia (podría ser texto libre
 * del usuario).
 */

export interface TemplateVariableContext {
    /** `contacts.full_name` — puede ser null si el contacto no tiene nombre capturado. */
    fullName: string | null;
    /** `contacts.business_name` del destinatario. */
    businessName: string | null;
    /** `organizations.name` de quien envía — distinto de `businessName` del contacto. */
    senderOrganizationName: string;
}

const FALLBACK_NAME = 'Estimado(a) cliente';

function firstName(fullName: string | null): string {
    if (!fullName || fullName.trim() === '') {
        return FALLBACK_NAME;
    }
    const trimmed = fullName.trim();
    const firstSpace = trimmed.indexOf(' ');
    return firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
}

export function interpolateTemplateVariables(template: string, ctx: TemplateVariableContext): string {
    const replacements: Record<string, string> = {
        primer_nombre: firstName(ctx.fullName),
        nombre_completo: ctx.fullName?.trim() || FALLBACK_NAME,
        empresa: ctx.businessName?.trim() || '',
        mi_empresa: ctx.senderOrganizationName,
    };

    return template.replace(/\{(primer_nombre|nombre_completo|empresa|mi_empresa)\}/g, (_match, key: string) => replacements[key]);
}
