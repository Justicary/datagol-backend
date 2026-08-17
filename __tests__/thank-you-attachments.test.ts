import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAttachmentMagicBytes, MAX_ATTACHMENT_SIZE_BYTES } from '../src/lib/magic-bytes.js';
import {
    uploadOrganizationAttachment,
    listOrganizationAttachments,
    archiveOrganizationAttachment,
    getActiveOrganizationAttachment,
    generateAttachmentSignedUrl,
    downloadAttachmentBuffer,
    ATTACHMENTS_BUCKET,
} from '../src/services/attachment-service.js';
import type { FastifyInstance } from 'fastify';

describe('Agradecimiento Automático — Validación y Gestión de Adjuntos', () => {
    describe('validateAttachmentMagicBytes', () => {
        it('reconoce correctamente un PDF legítimo (%PDF-)', () => {
            const pdfBuffer = Buffer.from('%PDF-1.7\n%Fake PDF content for test');
            const result = validateAttachmentMagicBytes(pdfBuffer);
            expect(result).not.toBeNull();
            expect(result?.extension).toBe('pdf');
            expect(result?.mimeType).toBe('application/pdf');
        });

        it('reconoce un archivo XLSX legítimo (ZIP con marcadores de Excel)', () => {
            // Cabecera PK\x03\x04 + contenido simulando paquete OpenXML con 'xl/workbook.xml'
            const xlsxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
            const xlsxBody = Buffer.from('some content including xl/workbook.xml and [Content_Types].xml');
            const xlsxBuffer = Buffer.concat([xlsxHeader, xlsxBody]);

            const result = validateAttachmentMagicBytes(xlsxBuffer);
            expect(result).not.toBeNull();
            expect(result?.extension).toBe('xlsx');
            expect(result?.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        });

        it('reconoce un archivo DOCX legítimo (ZIP con marcadores de Word)', () => {
            // Cabecera PK\x03\x04 + contenido simulando paquete OpenXML con 'word/document.xml'
            const docxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
            const docxBody = Buffer.from('some content including word/document.xml and [Content_Types].xml');
            const docxBuffer = Buffer.concat([docxHeader, docxBody]);

            const result = validateAttachmentMagicBytes(docxBuffer);
            expect(result).not.toBeNull();
            expect(result?.extension).toBe('docx');
            expect(result?.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        });

        it('rechaza un archivo ejecutable (MZ de Windows) aunque tenga extensión .pdf', () => {
            const exeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff');
            const result = validateAttachmentMagicBytes(exeBuffer);
            expect(result).toBeNull();
        });

        it('rechaza un script ejecutable (#!/bin/sh) aunque se le llame brochure.docx', () => {
            const scriptBuffer = Buffer.from('#!/bin/bash\necho "exploit"');
            const result = validateAttachmentMagicBytes(scriptBuffer);
            expect(result).toBeNull();
        });

        it('rechaza un archivo ZIP genérico que no sea DOCX ni XLSX', () => {
            const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
            const zipBody = Buffer.from('generic zip content without openxml parts');
            const zipBuffer = Buffer.concat([zipHeader, zipBody]);

            const result = validateAttachmentMagicBytes(zipBuffer);
            expect(result).toBeNull();
        });

        it('rechaza un archivo que excede el límite máximo de 10 MB', () => {
            const hugeBuffer = Buffer.alloc(MAX_ATTACHMENT_SIZE_BYTES + 1024, '%PDF-1.4');
            const result = validateAttachmentMagicBytes(hugeBuffer);
            expect(result).toBeNull();
        });

        it('rechaza buffers vacíos o demasiado pequeños (< 8 bytes)', () => {
            expect(validateAttachmentMagicBytes(Buffer.alloc(0))).toBeNull();
            expect(validateAttachmentMagicBytes(Buffer.from('tiny'))).toBeNull();
        });
    });

    describe('AttachmentService (Operaciones de almacenamiento)', () => {
        let fakeFastify: any;
        let mockStorageUpload: any;
        let mockStorageCreateSignedUrl: any;
        let mockStorageDownload: any;
        let mockFrom: any;

        beforeEach(() => {
            mockStorageUpload = vi.fn().mockResolvedValue({ error: null });
            mockStorageCreateSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://storage.supabase.co/signed/demo.pdf' }, error: null });
            mockStorageDownload = vi.fn().mockResolvedValue({ data: { arrayBuffer: () => Promise.resolve(Buffer.from('downloaded-content')) }, error: null });

            mockFrom = vi.fn().mockReturnValue({
                upload: mockStorageUpload,
                createSignedUrl: mockStorageCreateSignedUrl,
                download: mockStorageDownload,
            });

            fakeFastify = {
                supabaseAdmin: {
                    storage: {
                        listBuckets: vi.fn().mockResolvedValue({ data: [{ name: ATTACHMENTS_BUCKET }] }),
                        createBucket: vi.fn().mockResolvedValue({ error: null }),
                        from: mockFrom,
                    },
                    from: vi.fn(),
                },
                log: {
                    info: vi.fn(),
                    warn: vi.fn(),
                    error: vi.fn(),
                },
            };
        });

        it('uploadOrganizationAttachment sube a Storage e inserta en BD', async () => {
            const mockDbRecord = {
                id: 'att-123',
                organization_id: 'org-123',
                file_name: 'catalogo.pdf',
                mime_type: 'application/pdf',
                size_bytes: 100,
                storage_path: 'org-123/att-123-catalogo.pdf',
                is_active: true,
                uploaded_by: 'user-123',
                created_at: new Date().toISOString(),
                archived_at: null,
            };

            const insertMock = vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: mockDbRecord, error: null }),
                }),
            });

            const orgSelectMock = vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { integration_settings: {} }, error: null }),
                }),
            });

            const orgUpdateMock = vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
            });

            (fakeFastify.supabaseAdmin.from as any).mockImplementation((table: string) => {
                if (table === 'organization_attachments') {
                    return { insert: insertMock };
                }
                if (table === 'organizations') {
                    return { select: orgSelectMock, update: orgUpdateMock };
                }
                return {};
            });

            const pdfBuffer = Buffer.from('%PDF-1.7\nContent');
            const result = await uploadOrganizationAttachment(fakeFastify, {
                organizationId: 'org-123',
                fileName: 'catalogo.pdf',
                fileBuffer: pdfBuffer,
                userId: 'user-123',
            });

            expect(result.id).toBe('att-123');
            expect(result.is_active).toBe(true);
            expect(mockStorageUpload).toHaveBeenCalledTimes(1);
            expect(insertMock).toHaveBeenCalledTimes(1);
        });

        it('uploadOrganizationAttachment arroja error con archivo inválido', async () => {
            const invalidBuffer = Buffer.from('Not a pdf nor docx');
            await expect(
                uploadOrganizationAttachment(fakeFastify, {
                    organizationId: 'org-123',
                    fileName: 'virus.exe',
                    fileBuffer: invalidBuffer,
                })
            ).rejects.toThrow(/El archivo no es un documento válido/);
        });

        it('archiveOrganizationAttachment desactiva y archiva el registro', async () => {
            const updateMock = vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ error: null }),
                }),
            });

            const orgSelectMock = vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { integration_settings: { thankYou: { attachmentId: 'att-123' } } }, error: null }),
                }),
            });

            const orgUpdateMock = vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ error: null }),
            });

            (fakeFastify.supabaseAdmin.from as any).mockImplementation((table: string) => {
                if (table === 'organization_attachments') {
                    return { update: updateMock };
                }
                if (table === 'organizations') {
                    return { select: orgSelectMock, update: orgUpdateMock };
                }
                return {};
            });

            const archived = await archiveOrganizationAttachment(fakeFastify, 'org-123', 'att-123');
            expect(archived).toBe(true);
            expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ is_active: false, archived_at: expect.any(String) }));
        });

        it('generateAttachmentSignedUrl retorna URL firmada', async () => {
            const url = await generateAttachmentSignedUrl(fakeFastify, 'org-123/test.pdf', 3600);
            expect(url).toBe('https://storage.supabase.co/signed/demo.pdf');
            expect(mockStorageCreateSignedUrl).toHaveBeenCalledWith('org-123/test.pdf', 3600);
        });

        it('downloadAttachmentBuffer descarga y convierte a Buffer', async () => {
            const buf = await downloadAttachmentBuffer(fakeFastify, 'org-123/test.pdf');
            expect(buf).toBeInstanceOf(Buffer);
            expect(buf?.toString()).toBe('downloaded-content');
        });
    });
});
