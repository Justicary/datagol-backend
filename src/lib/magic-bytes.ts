/**
 * Validador seguro de tipos de archivo basado en cabeceras binarias (Magic Bytes).
 * Protege contra extensiones y Content-Type falsificados por el cliente.
 */

export interface ValidatedFileMime {
    mimeType: string;
    extension: 'pdf' | 'docx' | 'xlsx';
}

export const ALLOWED_MIME_TYPES = {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Inspecciona el buffer binario para verificar si corresponde a un PDF, DOCX o XLSX legítimo.
 * Retorna el MIME type canónico y extensión, o `null` si el archivo no es válido o está corrupto.
 */
export function validateAttachmentMagicBytes(buffer: Buffer): ValidatedFileMime | null {
    if (!buffer || buffer.length < 8) {
        return null;
    }

    if (buffer.length > MAX_ATTACHMENT_SIZE_BYTES) {
        return null;
    }

    // 1. Detección de PDF: Debe iniciar con "%PDF-" (0x25 0x50 0x44 0x46)
    if (
        buffer[0] === 0x25 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x44 &&
        buffer[3] === 0x46
    ) {
        return {
            mimeType: ALLOWED_MIME_TYPES.PDF,
            extension: 'pdf',
        };
    }

    // 2. Detección de ZIP / OpenXML: Inicia con "PK\x03\x04" (0x50 0x4b 0x03 0x04)
    if (
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04
    ) {
        // Buscar marcadores de paquetes OpenXML dentro del buffer
        const bufferString = buffer.toString('binary');

        // XLSX contiene típicamente "xl/" o "[Content_Types].xml" con "spreadsheetml"
        const isXlsx =
            bufferString.includes('xl/') ||
            bufferString.includes('spreadsheetml');

        if (isXlsx) {
            return {
                mimeType: ALLOWED_MIME_TYPES.XLSX,
                extension: 'xlsx',
            };
        }

        // DOCX contiene típicamente "word/" o "[Content_Types].xml" con "wordprocessingml"
        const isDocx =
            bufferString.includes('word/') ||
            bufferString.includes('wordprocessingml');

        if (isDocx) {
            return {
                mimeType: ALLOWED_MIME_TYPES.DOCX,
                extension: 'docx',
            };
        }

        // Si es un archivo ZIP genérico pero no es DOCX ni XLSX, se rechaza
        return null;
    }

    // Ninguna firma admitida coincidió
    return null;
}
