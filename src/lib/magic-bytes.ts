/**
 * Validador seguro de tipos de archivo basado en cabeceras binarias (Magic Bytes).
 * Protege contra extensiones y Content-Type falsificados por el cliente.
 */

export interface ValidatedFileMime {
    mimeType: string;
    extension: 'pdf' | 'docx' | 'xlsx' | 'png' | 'jpg';
}

export const ALLOWED_MIME_TYPES = {
    PDF: 'application/pdf',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    PNG: 'image/png',
    JPEG: 'image/jpeg',
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

    // 3. Detección de PNG: firma fija de 8 bytes 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return {
            mimeType: ALLOWED_MIME_TYPES.PNG,
            extension: 'png',
        };
    }

    // 4. Detección de JPEG: inicia con el marcador SOI 0xFF 0xD8 0xFF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return {
            mimeType: ALLOWED_MIME_TYPES.JPEG,
            extension: 'jpg',
        };
    }

    // Ninguna firma admitida coincidió
    return null;
}
