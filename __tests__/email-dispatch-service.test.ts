import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const getAccountCredentialsMock = vi.fn();
vi.mock('../src/services/email/email-account-vault.js', () => ({
    getAccountCredentials: (...args: unknown[]) => getAccountCredentialsMock(...args),
}));

const sendEmailMock = vi.fn();
vi.mock('../src/services/email/smtp-client.js', () => ({
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

import { dispatchOrSaveDraft, type DispatchEmailPayload } from '../src/services/email/email-dispatch.service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { logger } from '../src/lib/logger.js';

/**
 * Pruebas unitarias directas de `dispatchOrSaveDraft` — a diferencia de
 * `__tests__/tools-email.test.ts` (que ejercita esta capa a través de la
 * ruta HTTP completa), aquí se mockean únicamente las dos dependencias
 * externas reales (`getAccountCredentials`, `sendEmail`) y se usa la base
 * real para `organizations`/`email_accounts`/`email_outbox`, permitiendo
 * ejercitar con precisión cada rama de idempotencia, carrera y bitácora.
 */
describe('src/services/email/email-dispatch.service.ts', () => {
    let orgId: string;
    let activeAccountId: string;
    const createdOrgIds: string[] = [];

    async function createOrg(): Promise<string> {
        const { data, error } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Org Pruebas EmailDispatch', email: `test-email-dispatch-${crypto.randomUUID()}@example.invalid` })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear la organización: ${error?.message}`);
        createdOrgIds.push(data.id as string);
        return data.id as string;
    }

    async function createAccount(organizationId: string, status: 'active' | 'error' | 'disabled' = 'active'): Promise<string> {
        const { data, error } = await supabaseAdmin
            .from('email_accounts')
            .insert({
                organization_id: organizationId,
                email_address: `buzon-dispatch-${crypto.randomUUID()}@example.invalid`,
                imap_host: 'imap.example.invalid',
                imap_port: 993,
                imap_secure: true,
                imap_username: 'usuario-imap',
                smtp_host: 'smtp.example.invalid',
                smtp_port: 465,
                smtp_secure: true,
                smtp_username: 'usuario-smtp',
                vault_secret_id: crypto.randomUUID(),
                status,
            })
            .select('id')
            .single();
        if (error || !data) throw new Error(`No se pudo crear el buzón: ${error?.message}`);
        return data.id as string;
    }

    function buildPayload(overrides: Partial<DispatchEmailPayload> = {}): DispatchEmailPayload {
        return {
            idempotencyKey: crypto.randomUUID(),
            toAddresses: ['destino@example.invalid'],
            subject: 'Asunto de prueba',
            bodyText: 'Cuerpo de prueba',
            isDraft: true,
            ...overrides,
        };
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        getAccountCredentialsMock.mockResolvedValue({ imapPassword: 'imap-pass', smtpPassword: 'smtp-pass' });
        sendEmailMock.mockResolvedValue({ providerMessageId: 'provider-msg-1' });
        orgId = await createOrg();
        activeAccountId = await createAccount(orgId, 'active');
    });

    afterEach(async () => {
        for (const id of createdOrgIds.splice(0)) {
            await supabaseAdmin.from('email_outbox').delete().eq('organization_id', id);
            await supabaseAdmin.from('email_accounts').delete().eq('organization_id', id);
            await supabaseAdmin.from('contacts').delete().eq('organization_id', id);
            await supabaseAdmin.from('organizations').delete().eq('id', id);
        }
        vi.restoreAllMocks();
    });

    describe('idempotencia (findExistingByIdempotencyKey)', () => {
        it('un idempotencyKey ya guardado como borrador devuelve el mismo resultado sin volver a escribir', async () => {
            const idempotencyKey = crypto.randomUUID();
            const first = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: true }));
            expect(first.success).toBe(true);

            const second = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: true, subject: 'otro asunto' }));
            expect(second.success).toBe(true);
            if (second.success && first.success) {
                expect(second.outboxId).toBe(first.outboxId);
                expect(second.status).toBe('draft');
                expect(second.message).toBe('Este borrador ya había sido guardado.');
            }

            const { data: rows } = await supabaseAdmin.from('email_outbox').select('id').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey);
            expect(rows?.length).toBe(1);
        });

        it('un idempotencyKey ya guardado como enviado devuelve el mensaje "ya había sido enviado"', async () => {
            const idempotencyKey = crypto.randomUUID();
            await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));

            const second = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));
            expect(second.success).toBe(true);
            if (second.success) {
                expect(second.status).toBe('sent');
                expect(second.message).toBe('Este correo ya había sido enviado.');
            }
            expect(sendEmailMock).toHaveBeenCalledTimes(1); // no se reenvía en el segundo intento
        });
    });

    describe('resolución de la cuenta', () => {
        it('devuelve 404 si el emailAccountId no existe', async () => {
            const result = await dispatchOrSaveDraft(orgId, crypto.randomUUID(), buildPayload());
            expect(result).toEqual({ success: false, error: 'El buzón indicado no existe o no pertenece a esta organización.', statusCode: 404 });
        });

        it('devuelve 404 si el buzón pertenece a otra organización (aislamiento multi-tenant)', async () => {
            const otherOrgId = await createOrg();
            const result = await dispatchOrSaveDraft(otherOrgId, activeAccountId, buildPayload());
            expect(result.success).toBe(false);
            if (!result.success) expect(result.statusCode).toBe(404);
        });
    });

    describe('borrador (isDraft: true)', () => {
        it('inserta la fila con status=draft y no invoca getAccountCredentials ni sendEmail', async () => {
            const { data: contact, error: contactErr } = await supabaseAdmin
                .from('contacts')
                .insert({ organization_id: orgId, email: `contacto-${crypto.randomUUID()}@example.invalid` })
                .select('id')
                .single();
            if (contactErr || !contact) throw new Error(`No se pudo crear el contacto: ${contactErr?.message}`);

            const payload = buildPayload({ isDraft: true, ccAddresses: ['cc@example.invalid'], contactId: contact.id as string, bodyHtml: '<p>hola</p>' });
            const result = await dispatchOrSaveDraft(orgId, activeAccountId, payload);

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.status).toBe('draft');
                expect(result.message).toBe('Borrador guardado.');
            }
            expect(getAccountCredentialsMock).not.toHaveBeenCalled();
            expect(sendEmailMock).not.toHaveBeenCalled();

            const { data: row } = await supabaseAdmin
                .from('email_outbox')
                .select('*')
                .eq('organization_id', orgId)
                .eq('idempotency_key', payload.idempotencyKey)
                .single();
            expect(row.status).toBe('draft');
            expect(row.to_addresses).toEqual(['destino@example.invalid']);
            expect(row.cc_addresses).toEqual(['cc@example.invalid']);
            expect(row.contact_id).toBe(payload.contactId);
            expect(row.body_html).toBe('<p>hola</p>');
            expect(row.provider_message_id).toBeNull();
            expect(row.sent_at).toBeNull();
        });

        it('cc_addresses y contact_id quedan null cuando no se proporcionan', async () => {
            const payload = buildPayload({ isDraft: true });
            await dispatchOrSaveDraft(orgId, activeAccountId, payload);

            const { data: row } = await supabaseAdmin
                .from('email_outbox')
                .select('cc_addresses, contact_id, body_html')
                .eq('organization_id', orgId)
                .eq('idempotency_key', payload.idempotencyKey)
                .single();
            expect(row.cc_addresses).toBeNull();
            expect(row.contact_id).toBeNull();
            expect(row.body_html).toBeNull();
        });
    });

    describe('envío (isDraft: false)', () => {
        it('rechaza con 400 si el buzón no está activo (status: disabled)', async () => {
            const disabledAccountId = await createAccount(orgId, 'disabled');
            const result = await dispatchOrSaveDraft(orgId, disabledAccountId, buildPayload({ isDraft: false }));
            expect(result).toEqual({ success: false, error: 'Este buzón no está activo; no se puede enviar el correo.', statusCode: 400 });
            expect(sendEmailMock).not.toHaveBeenCalled();
        });

        it('rechaza con 400 si el buzón no está activo (status: error)', async () => {
            const errorAccountId = await createAccount(orgId, 'error');
            const result = await dispatchOrSaveDraft(orgId, errorAccountId, buildPayload({ isDraft: false }));
            expect(result.success).toBe(false);
            if (!result.success) expect(result.statusCode).toBe(400);
        });

        it('rechaza con 400 si no se pueden recuperar las credenciales', async () => {
            getAccountCredentialsMock.mockResolvedValueOnce(null);
            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: false }));
            expect(result).toEqual({
                success: false,
                error: 'No se pudieron recuperar las credenciales del buzón. Verifica la configuración del buzón.',
                statusCode: 400,
            });
        });

        it('contraparte de éxito: envía, inserta status=sent con provider_message_id y sent_at, y devuelve el mensaje correcto', async () => {
            sendEmailMock.mockResolvedValueOnce({ providerMessageId: 'abc-123' });
            const payload = buildPayload({ isDraft: false });
            const result = await dispatchOrSaveDraft(orgId, activeAccountId, payload);

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.status).toBe('sent');
                expect(result.message).toBe('Correo enviado con éxito.');
            }

            const { data: row } = await supabaseAdmin
                .from('email_outbox')
                .select('status, provider_message_id, sent_at, error_message')
                .eq('organization_id', orgId)
                .eq('idempotency_key', payload.idempotencyKey)
                .single();
            expect(row.status).toBe('sent');
            expect(row.provider_message_id).toBe('abc-123');
            expect(row.sent_at).not.toBeNull();
            expect(row.error_message).toBeNull();
        });

        it('sendEmail se llama con los parámetros SMTP y de mensaje exactos', async () => {
            const payload = buildPayload({ isDraft: false, ccAddresses: ['cc@example.invalid'], bodyHtml: '<p>x</p>' });
            await dispatchOrSaveDraft(orgId, activeAccountId, payload);

            expect(sendEmailMock).toHaveBeenCalledWith(
                expect.objectContaining({ host: 'smtp.example.invalid', port: 465, secure: true, user: 'usuario-smtp', pass: 'smtp-pass' }),
                expect.objectContaining({
                    to: ['destino@example.invalid'],
                    cc: ['cc@example.invalid'],
                    subject: payload.subject,
                    text: payload.bodyText,
                    html: '<p>x</p>',
                })
            );
        });

        it('cuando sendEmail lanza un Error, registra status=failed con error_message exacto y devuelve el mensaje de fallo', async () => {
            sendEmailMock.mockRejectedValueOnce(new Error('535 authentication failed'));
            const payload = buildPayload({ isDraft: false });
            const result = await dispatchOrSaveDraft(orgId, activeAccountId, payload);

            expect(result).toEqual({ success: false, error: 'No se pudo enviar el correo: 535 authentication failed', statusCode: 400 });

            const { data: row } = await supabaseAdmin
                .from('email_outbox')
                .select('status, error_message, sent_at, provider_message_id')
                .eq('organization_id', orgId)
                .eq('idempotency_key', payload.idempotencyKey)
                .single();
            expect(row.status).toBe('failed');
            expect(row.error_message).toBe('535 authentication failed');
            expect(row.sent_at).toBeNull();
            expect(row.provider_message_id).toBeNull();
        });

        it('cuando sendEmail lanza un valor que no es Error, usa String(err) como mensaje', async () => {
            sendEmailMock.mockRejectedValueOnce('raw failure string');
            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: false }));
            expect(result).toEqual({ success: false, error: 'No se pudo enviar el correo: raw failure string', statusCode: 400 });
        });

        it('un segundo intento con el mismo idempotencyKey de un envío que ya falló repite el mismo fallo, sin reintentar sendEmail', async () => {
            const idempotencyKey = crypto.randomUUID();
            sendEmailMock.mockRejectedValueOnce(new Error('fallo persistente'));

            const first = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));
            expect(first).toEqual({ success: false, error: 'No se pudo enviar el correo: fallo persistente', statusCode: 400 });

            const second = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));
            expect(second).toEqual({ success: false, error: 'No se pudo enviar el correo: fallo persistente', statusCode: 400 });
            expect(sendEmailMock).toHaveBeenCalledTimes(1); // no se reintenta el envío en el segundo intento

            const { data: rows } = await supabaseAdmin.from('email_outbox').select('id').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey);
            expect(rows?.length).toBe(1);
        });

        it('recordFailedAttempt: una carrera real de dos envíos fallidos concurrentes con la misma clave no lanza ni duplica la fila (23505 silencioso)', async () => {
            const errorSpy = vi.spyOn(logger, 'error');
            const idempotencyKey = crypto.randomUUID();
            sendEmailMock.mockRejectedValue(new Error('fallo persistente'));

            // Fila 'failed' real pre-existente, simulando que otro proceso
            // concurrente ya registró este mismo intento fallido.
            await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));
            errorSpy.mockClear();

            // Se fuerza el chequeo inicial de idempotencia a "no existe" para
            // simular la ventana de carrera real (nuestra propia consulta
            // corrió antes de que el otro proceso terminara de escribir), de
            // modo que este intento llegue hasta recordFailedAttempt() y su
            // propio INSERT choque de verdad contra la fila ya existente.
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) }) as never);

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: false }));
            expect(result).toEqual({ success: false, error: 'No se pudo enviar el correo: fallo persistente', statusCode: 400 });
            expect(errorSpy).not.toHaveBeenCalledWith(
                expect.anything(),
                '[EmailDispatchService] No se pudo registrar el intento de envío fallido'
            );

            const { data: rows } = await supabaseAdmin.from('email_outbox').select('id').eq('organization_id', orgId).eq('idempotency_key', idempotencyKey);
            expect(rows?.length).toBe(1);
            fromSpy.mockRestore();
            errorSpy.mockRestore();
        });
    });

    describe('ramas de infraestructura mockeadas (supabaseAdmin.from)', () => {
        it('insertOutboxRow: en conflicto 23505 (borrador) devuelve el resultado del ganador de la carrera', async () => {
            const idempotencyKey = crypto.randomUUID();

            // Fila "ganadora" real, sin mocks — simula que otro proceso ya
            // escribió bajo esta clave antes de nuestro propio intento.
            const winner = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: true }));
            expect(winner.success).toBe(true);

            // Nuestro intento: el chequeo inicial de idempotencia se mockea
            // para simular que NO vio la fila ganadora todavía (carrera real),
            // pero el propio INSERT choca contra ella (23505) — el segundo
            // chequeo de idempotencia (dentro de insertOutboxRow) sí es real
            // y encuentra la fila ganadora recién creada arriba.
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }) }) as never) // idempotency check inicial (forzado a "no existe")
                .mockImplementationOnce(realFrom) // account lookup
                .mockImplementationOnce(
                    () =>
                        ({
                            insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } }) }) }),
                        }) as never
                );

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ idempotencyKey, isDraft: true }));
            expect(result.success).toBe(true);
            if (result.success && winner.success) {
                // Mismo id/estado que la fila ganadora — el mensaje difiere
                // ("recién creado" vs. "ya existía") porque son caminos de
                // código distintos que llegan al mismo dato real.
                expect(result.outboxId).toBe(winner.outboxId);
                expect(result.status).toBe(winner.status);
                expect(result.message).toBe('Este borrador ya había sido guardado.');
            }
            fromSpy.mockRestore();
        });

        it('insertOutboxRow: error de inserción no-23505 sin ganador de carrera responde 400 con el mensaje exacto', async () => {
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom)
                .mockImplementationOnce(realFrom)
                .mockImplementationOnce(
                    () =>
                        ({
                            insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'OTHER', message: 'disco lleno' } }) }) }),
                        }) as never
                );

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: true }));
            expect(result).toEqual({ success: false, error: 'disco lleno', statusCode: 400 });
            fromSpy.mockRestore();
        });

        it('insertOutboxRow: usa "error desconocido" cuando el error de inserción no trae message', async () => {
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom)
                .mockImplementationOnce(realFrom)
                .mockImplementationOnce(
                    () =>
                        ({
                            insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'OTHER' } }) }) }),
                        }) as never
                );

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: true }));
            expect(result).toEqual({ success: false, error: 'error desconocido', statusCode: 400 });
            fromSpy.mockRestore();
        });

        it('cuando el envío tuvo éxito pero la bitácora no se pudo escribir, informa el envío real y registra el error', async () => {
            const errorSpy = vi.spyOn(logger, 'error');
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom) // idempotency check
                .mockImplementationOnce(realFrom) // account lookup
                .mockImplementationOnce(
                    () =>
                        ({
                            insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'OTHER', message: 'bitácora caída' } }) }) }),
                        }) as never
                );

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: false }));

            expect(result).toEqual({ success: true, outboxId: '', status: 'sent', message: 'Correo enviado, pero no se pudo registrar la bitácora.' });
            expect(sendEmailMock).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: orgId, error: 'bitácora caída' }),
                '[EmailDispatchService] Correo enviado pero no se pudo registrar en email_outbox'
            );
            fromSpy.mockRestore();
            errorSpy.mockRestore();
        });

        it('recordFailedAttempt: registra el error con la forma exacta cuando la inserción del intento fallido no es un conflicto de idempotencia', async () => {
            const errorSpy = vi.spyOn(logger, 'error');
            sendEmailMock.mockRejectedValueOnce(new Error('smtp caído'));
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom) // idempotency check
                .mockImplementationOnce(realFrom) // account lookup
                .mockImplementationOnce(
                    () =>
                        ({
                            insert: () => Promise.resolve({ error: { code: 'OTHER', message: 'no se pudo registrar el fallo' } }),
                        }) as never
                );

            const result = await dispatchOrSaveDraft(orgId, activeAccountId, buildPayload({ isDraft: false }));
            expect(result).toEqual({ success: false, error: 'No se pudo enviar el correo: smtp caído', statusCode: 400 });
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: orgId, error: 'no se pudo registrar el fallo' }),
                '[EmailDispatchService] No se pudo registrar el intento de envío fallido'
            );
            fromSpy.mockRestore();
            errorSpy.mockRestore();
        });
    });
});
