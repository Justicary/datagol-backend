import { describe, it, expect } from 'vitest';
import { validateImageMagicBytes, MAX_PRODUCT_IMAGE_SIZE_BYTES } from '../src/lib/magic-bytes.js';

function pngBuffer(sizeBytes = 100): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([signature, Buffer.alloc(Math.max(0, sizeBytes - signature.length))]);
}

function jpegBuffer(): Buffer {
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function webpBuffer(sizeBytes = 100): Buffer {
    // "RIFF" + tamaño (4 bytes, irrelevantes para la validación) + "WEBP"
    const signature = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    return Buffer.concat([signature, Buffer.alloc(Math.max(0, sizeBytes - signature.length))]);
}

describe('src/lib/magic-bytes.ts — validateImageMagicBytes', () => {
    it('acepta un PNG con firma válida', () => {
        expect(validateImageMagicBytes(pngBuffer())).toEqual({ mimeType: 'image/png', extension: 'png' });
    });

    it('acepta un JPEG con firma válida', () => {
        expect(validateImageMagicBytes(jpegBuffer())).toEqual({ mimeType: 'image/jpeg', extension: 'jpg' });
    });

    it('acepta un WebP con firma válida (RIFF....WEBP)', () => {
        expect(validateImageMagicBytes(webpBuffer())).toEqual({ mimeType: 'image/webp', extension: 'webp' });
    });

    it('contraparte de rechazo: un contenedor RIFF que no es WEBP (ej. WAV) se rechaza', () => {
        const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
        expect(validateImageMagicBytes(wav)).toBeNull();
    });

    it('contraparte de rechazo: un PDF (firma distinta) se rechaza aunque tenga tamaño válido', () => {
        expect(validateImageMagicBytes(Buffer.from('%PDF-1.7\ncontenido'))).toBeNull();
    });

    it('contraparte de rechazo: un ZIP/DOCX/XLSX (firma PK) NO es una imagen y se rechaza', () => {
        expect(validateImageMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBeNull();
    });

    it('un buffer más corto que 8 bytes se rechaza', () => {
        expect(validateImageMagicBytes(Buffer.from([0x89, 0x50]))).toBeNull();
    });

    it('un PNG que excede el tope por defecto (5 MB) se rechaza', () => {
        expect(validateImageMagicBytes(pngBuffer(MAX_PRODUCT_IMAGE_SIZE_BYTES + 1))).toBeNull();
    });

    it('contraparte de éxito: un PNG exactamente en el tope por defecto se acepta', () => {
        expect(validateImageMagicBytes(pngBuffer(MAX_PRODUCT_IMAGE_SIZE_BYTES))).not.toBeNull();
    });

    it('el tope de tamaño es configurable vía el segundo parámetro', () => {
        expect(validateImageMagicBytes(pngBuffer(1000), 500)).toBeNull();
        expect(validateImageMagicBytes(pngBuffer(400), 500)).not.toBeNull();
    });
});
