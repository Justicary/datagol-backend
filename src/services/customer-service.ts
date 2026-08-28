import { FastifyInstance } from 'fastify';

export class CustomerServiceError extends Error {
    constructor(message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'CustomerServiceError';
    }
}

export interface CustomerInput {
    legalName: string;
    tradeName?: string | null;
    rfc?: string | null;
    taxRegime?: string | null;
    fiscalAddress?: string | null;
    fiscalCity?: string | null;
    fiscalState?: string | null;
    fiscalPostalCode?: string | null;
    contactName: string;
    contactRole?: string | null;
    contactEmail: string;
    contactPhoneE164?: string | null;
    businessSector?: string | null;
    notes?: string | null;
}

function toRow(input: Partial<CustomerInput>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (input.legalName !== undefined) row.legal_name = input.legalName;
    if (input.tradeName !== undefined) row.trade_name = input.tradeName;
    if (input.rfc !== undefined) row.rfc = input.rfc;
    if (input.taxRegime !== undefined) row.tax_regime = input.taxRegime;
    if (input.fiscalAddress !== undefined) row.fiscal_address = input.fiscalAddress;
    if (input.fiscalCity !== undefined) row.fiscal_city = input.fiscalCity;
    if (input.fiscalState !== undefined) row.fiscal_state = input.fiscalState;
    if (input.fiscalPostalCode !== undefined) row.fiscal_postal_code = input.fiscalPostalCode;
    if (input.contactName !== undefined) row.contact_name = input.contactName;
    if (input.contactRole !== undefined) row.contact_role = input.contactRole;
    if (input.contactEmail !== undefined) row.contact_email = input.contactEmail;
    if (input.contactPhoneE164 !== undefined) row.contact_phone_e164 = input.contactPhoneE164;
    if (input.businessSector !== undefined) row.business_sector = input.businessSector;
    if (input.notes !== undefined) row.notes = input.notes;
    return row;
}

export async function createCustomer(fastify: FastifyInstance, input: CustomerInput) {
    const { data, error } = await fastify.supabaseAdmin.from('customers').insert(toRow(input)).select('*').single();

    if (error || !data) {
        throw new CustomerServiceError(`No se pudo crear el cliente: ${error?.message ?? 'error desconocido'}`, 400);
    }
    return data;
}

export async function getCustomer(fastify: FastifyInstance, customerId: string) {
    const { data, error } = await fastify.supabaseAdmin.from('customers').select('*').eq('id', customerId).maybeSingle();

    if (error || !data) {
        throw new CustomerServiceError(`El cliente '${customerId}' no existe.`, 404);
    }
    return data;
}

export async function listCustomers(fastify: FastifyInstance) {
    const { data, error } = await fastify.supabaseAdmin.from('customers').select('*').order('created_at', { ascending: false });

    if (error) {
        throw new CustomerServiceError(`No se pudo listar clientes: ${error.message}`, 500);
    }
    return data ?? [];
}

export async function updateCustomer(fastify: FastifyInstance, customerId: string, input: Partial<CustomerInput>) {
    const { data, error } = await fastify.supabaseAdmin
        .from('customers')
        .update(toRow(input))
        .eq('id', customerId)
        .select('*')
        .maybeSingle();

    if (error) {
        throw new CustomerServiceError(`No se pudo actualizar el cliente: ${error.message}`, 400);
    }
    if (!data) {
        throw new CustomerServiceError(`El cliente '${customerId}' no existe.`, 404);
    }
    return data;
}
