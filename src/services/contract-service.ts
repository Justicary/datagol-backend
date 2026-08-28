import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { FastifyInstance } from 'fastify';
import { verifyContractOtp } from './contract-otp-service.js';

export class ContractServiceError extends Error {
    constructor(message: string, public readonly statusCode: number) {
        super(message);
        this.name = 'ContractServiceError';
    }
}

export const CONTRACTS_BUCKET = 'control-plane-contracts';
const MAX_CONTRACT_PDF_BYTES = 5 * 1024 * 1024;

async function ensureContractsBucket(fastify: FastifyInstance): Promise<void> {
    try {
        const { data: buckets } = await fastify.supabaseAdmin.storage.listBuckets();
        const exists = buckets?.some((b) => b.name === CONTRACTS_BUCKET);
        if (!exists) {
            await fastify.supabaseAdmin.storage.createBucket(CONTRACTS_BUCKET, {
                public: false,
                fileSizeLimit: MAX_CONTRACT_PDF_BYTES,
            });
        }
    } catch (err) {
        fastify.log.warn({ err }, '[ContractService] Error al verificar/crear el bucket de contratos');
    }
}

interface ContractPdfParams {
    templateVersion: string;
    customerLegalName: string;
    customerRfc: string | null;
    deploymentSlug: string;
    planKey: string;
    signerName: string;
    signerRole: string | null;
    signerEmail: string;
}

/**
 * Genera el PDF del contrato. El texto es un placeholder estructural — la
 * redacción legal real debe revisarla un abogado antes del primer contrato
 * real (docs/tasks/control-plane-backend-datagol.md, Fase D, nota final).
 * Lo que SÍ es real: el buffer exacto es lo que se hashea y se firma.
 */
function generateContractPdfBuffer(params: ContractPdfParams): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk) => chunks.push(chunk as Buffer));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.fontSize(18).text('Contrato de Servicios Datagol', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).text(`Plantilla: ${params.templateVersion}`);
        doc.text(`Fecha de generación: ${new Date().toISOString()}`);
        doc.moveDown();
        doc.fontSize(12).text('Cliente contratante');
        doc.fontSize(10).text(`Razón social: ${params.customerLegalName}`);
        if (params.customerRfc) doc.text(`RFC: ${params.customerRfc}`);
        doc.moveDown();
        doc.fontSize(12).text('Despliegue contratado');
        doc.fontSize(10).text(`Identificador: ${params.deploymentSlug}`);
        doc.text(`Plan: ${params.planKey}`);
        doc.moveDown();
        doc.fontSize(12).text('Firmante');
        doc.fontSize(10).text(`Nombre: ${params.signerName}`);
        if (params.signerRole) doc.text(`Cargo: ${params.signerRole}`);
        doc.text(`Correo: ${params.signerEmail}`);
        doc.moveDown(2);
        doc.fontSize(9)
            .fillColor('#666666')
            .text(
                'Documento generado automáticamente por el plano de control de Datagol. La validez de la firma electrónica bajo la legislación mexicana depende de la calidad de esta evidencia y debe ser revisada por asesoría legal antes de su uso comercial.'
            );

        doc.end();
    });
}

export interface GenerateContractInput {
    deploymentId: string;
    templateVersion: string;
    signerName: string;
    signerRole?: string | null;
    signerEmail: string;
    signerPhoneE164?: string | null;
}

/**
 * Fase D — POST /control/deployments/:id/contract. Genera el PDF exacto, su
 * hash SHA-256 y lo sube al bucket privado. Se inserta la fila primero (sin
 * `pdf_storage_path`) para tener un `id` con el que construir la ruta de
 * Storage — el trigger de inmutabilidad de `55_...` no aplica todavía
 * porque `signed_at` sigue siendo `null`.
 */
export async function generateContract(fastify: FastifyInstance, input: GenerateContractInput) {
    const { data: deployment, error: deploymentError } = await fastify.supabaseAdmin
        .from('deployments')
        .select('id, slug, plan_key, customer_id')
        .eq('id', input.deploymentId)
        .maybeSingle();

    if (deploymentError || !deployment) {
        throw new ContractServiceError(`El despliegue '${input.deploymentId}' no existe.`, 404);
    }

    const { data: customer } = await fastify.supabaseAdmin
        .from('customers')
        .select('legal_name, rfc')
        .eq('id', deployment.customer_id)
        .maybeSingle();

    const { data: contract, error: insertError } = await fastify.supabaseAdmin
        .from('contracts')
        .insert({
            deployment_id: deployment.id,
            template_version: input.templateVersion,
            document_hash: '',
            signer_name: input.signerName,
            signer_role: input.signerRole ?? null,
            signer_email: input.signerEmail,
            signer_phone_e164: input.signerPhoneE164 ?? null,
        })
        .select('*')
        .single();

    if (insertError || !contract) {
        throw new ContractServiceError(`No se pudo crear el contrato: ${insertError?.message ?? 'error desconocido'}`, 400);
    }

    const pdfBuffer = await generateContractPdfBuffer({
        templateVersion: input.templateVersion,
        customerLegalName: customer?.legal_name ?? 'N/D',
        customerRfc: customer?.rfc ?? null,
        deploymentSlug: deployment.slug,
        planKey: deployment.plan_key,
        signerName: input.signerName,
        signerRole: input.signerRole ?? null,
        signerEmail: input.signerEmail,
    });

    const documentHash = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    const storagePath = `${deployment.id}/${contract.id}.pdf`;

    await ensureContractsBucket(fastify);
    const { error: uploadError } = await fastify.supabaseAdmin.storage.from(CONTRACTS_BUCKET).upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
    });

    if (uploadError) {
        throw new ContractServiceError(`No se pudo almacenar el PDF del contrato: ${uploadError.message}`, 500);
    }

    const { data: updated, error: updateError } = await fastify.supabaseAdmin
        .from('contracts')
        .update({ document_hash: documentHash, pdf_storage_path: storagePath })
        .eq('id', contract.id)
        .select('*')
        .single();

    if (updateError || !updated) {
        throw new ContractServiceError(`No se pudo registrar el hash del contrato: ${updateError?.message ?? 'error desconocido'}`, 500);
    }

    return updated;
}

export async function getContractSignedPdfUrl(fastify: FastifyInstance, contractId: string, expiresInSeconds = 3600): Promise<string> {
    const { data: contract, error } = await fastify.supabaseAdmin.from('contracts').select('pdf_storage_path').eq('id', contractId).maybeSingle();

    if (error || !contract || !contract.pdf_storage_path) {
        throw new ContractServiceError(`El contrato '${contractId}' no existe o aún no tiene PDF generado.`, 404);
    }

    const { data, error: signError } = await fastify.supabaseAdmin.storage
        .from(CONTRACTS_BUCKET)
        .createSignedUrl(contract.pdf_storage_path, expiresInSeconds);

    if (signError || !data?.signedUrl) {
        throw new ContractServiceError('No se pudo generar la URL firmada del PDF.', 500);
    }

    return data.signedUrl;
}

export interface SignContractResult {
    success: boolean;
    reason?: string;
    contract?: Record<string, unknown>;
}

/**
 * Fase D — POST /control/contracts/:id/sign. La inmutabilidad post-firma la
 * garantiza el trigger `forbid_signed_contract_mutation` de `55_...`; aquí
 * solo se traduce ese fallo de Postgres a un 409 legible en vez de dejarlo
 * pasar crudo (AGENTS.md §11 — "manejador de errores centralizado... ningún
 * handler devuelve errores crudos del proveedor").
 */
export async function signContract(
    fastify: FastifyInstance,
    contractId: string,
    code: string,
    signerIp: string | null,
    signerUserAgent: string | null
): Promise<SignContractResult> {
    const { data: contract, error: fetchError } = await fastify.supabaseAdmin
        .from('contracts')
        .select('id, signed_at, voided_at')
        .eq('id', contractId)
        .maybeSingle();

    if (fetchError || !contract) {
        return { success: false, reason: `El contrato '${contractId}' no existe.` };
    }
    if (contract.signed_at) {
        return { success: false, reason: 'Este contrato ya está firmado.' };
    }
    if (contract.voided_at) {
        return { success: false, reason: 'Este contrato fue anulado.' };
    }

    const otpResult = await verifyContractOtp(fastify, contractId, code);
    if (!otpResult.verified) {
        return { success: false, reason: otpResult.reason ?? 'El código de verificación no es válido.' };
    }

    const { data: signed, error: signError } = await fastify.supabaseAdmin
        .from('contracts')
        .update({
            signed_at: new Date().toISOString(),
            verification_method: 'email_otp',
            verified_at: new Date().toISOString(),
            signer_ip: signerIp,
            signer_user_agent: signerUserAgent,
        })
        .eq('id', contractId)
        .is('signed_at', null)
        .select('*')
        .maybeSingle();

    if (signError) {
        if (signError.message.includes('no puede modificarse')) {
            return { success: false, reason: 'Este contrato ya está firmado.' };
        }
        return { success: false, reason: `No se pudo registrar la firma: ${signError.message}` };
    }
    if (!signed) {
        return { success: false, reason: 'Este contrato ya está firmado.' };
    }

    return { success: true, contract: signed };
}
