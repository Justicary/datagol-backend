import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

// imapflow/nodemailer son SDKs reales que hablarían con un servidor de
// correo de verdad — no hay uno disponible en el entorno de pruebas, así
// que se mockean directamente (no el wrapper propio), igual convención que
// el resto del proyecto usa para SDKs de terceros genuinos.
let imapShouldFail = false;
let smtpShouldFail = false;
let imapConnectCallCount = 0;
let lastImapFlowConfig: unknown = null;
let lastSmtpTransportConfig: unknown = null;

vi.mock('imapflow', () => ({
    // `new ImapFlow(...)` exige que la implementación sea invocable con
    // `new` — una arrow function no lo es (lanza "is not a constructor").
    ImapFlow: vi.fn().mockImplementation(function ImapFlowMock(config: unknown) {
        lastImapFlowConfig = config;
        return {
            connect: vi.fn().mockImplementation(async () => {
                imapConnectCallCount++;
                if (imapShouldFail) throw new Error('Simulated IMAP auth failure');
            }),
            logout: vi.fn().mockResolvedValue(undefined),
        };
    }),
}));

vi.mock('nodemailer', () => ({
    default: {
        createTransport: vi.fn().mockImplementation((config: unknown) => {
            lastSmtpTransportConfig = config;
            return {
                verify: vi.fn().mockImplementation(async () => {
                    if (smtpShouldFail) throw new Error('Simulated SMTP auth failure');
                    return true;
                }),
                close: vi.fn(),
            };
        }),
    },
}));

// Mock parcial: preserva el comportamiento real (Vault real) pero envuelto en
// un vi.fn() espiable — permite verificar que el rollback de credenciales
// (deleteAccountCredentials) se invoca de verdad cuando una inserción falla
// después de haber creado el secreto, sin perder la limpieza real.
vi.mock('../src/services/email/email-account-vault.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/services/email/email-account-vault.js')>();
    return { ...actual, deleteAccountCredentials: vi.fn(actual.deleteAccountCredentials) };
});

import pg from 'pg';
import { validateAndSaveAccount, listAccounts, deleteAccount, type EmailAccountConfig } from '../src/services/email/email-account.service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { getAccountCredentials, deleteAccountCredentials } from '../src/services/email/email-account-vault.js';

function buildConfig(overrides: Partial<EmailAccountConfig> = {}): EmailAccountConfig {
    return {
        emailAddress: `buzon-${crypto.randomUUID()}@example.invalid`,
        providerLabel: 'custom',
        imapHost: 'imap.example.invalid',
        imapPort: 993,
        imapSecure: true,
        imapUsername: 'usuario-imap',
        imapPassword: 'clave-imap-secreta',
        smtpHost: 'smtp.example.invalid',
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: 'usuario-smtp',
        smtpPassword: 'clave-smtp-secreta',
        ...overrides,
    };
}

async function createTestOrg(maxMailboxes: number | null): Promise<string> {
    const { data, error } = await supabaseAdmin
        .from('organizations')
        .insert({
            name: 'Org Pruebas EmailAccountService',
            email: `test-email-account-service-${crypto.randomUUID()}@example.invalid`,
            max_mailboxes: maxMailboxes,
        })
        .select('id')
        .single();
    if (error || !data) throw new Error(`No se pudo crear la organización dedicada: ${error?.message}`);
    return data.id as string;
}

/**
 * Envuelve un query builder real de supabase-js en un Proxy que registra
 * cada llamada a un método de encadenamiento (select/eq/insert/order/delete)
 * con sus argumentos exactos, dejando pasar `single`/`maybeSingle`/`then`
 * (los que disparan la ejecución real) sin tocar — mata mutantes de
 * StringLiteral/ObjectLiteral sobre nombres de columna y filtros
 * (`.select('id')` -> `.select('')`, `.eq('organization_id', x)` -> `.eq('', x)`)
 * que un `toEqual` sobre el resultado final no puede distinguir porque
 * PostgREST tolera algunos de esos casos sin cambiar la fila devuelta.
 */
const CHAIN_METHODS = new Set(['select', 'eq', 'insert', 'order', 'delete']);
type RecordedCall = { method: string; args: unknown[] };

function recordCalls<T extends object>(realObj: T, log: RecordedCall[]): T {
    return new Proxy(realObj, {
        get(target, prop) {
            const value = (target as Record<PropertyKey, unknown>)[prop as string];
            if (typeof value !== 'function') return value;
            const bound = value.bind(target);
            if (!CHAIN_METHODS.has(String(prop))) return bound;
            return (...args: unknown[]) => {
                log.push({ method: String(prop), args });
                return recordCalls(bound(...args) as object, log);
            };
        },
    }) as T;
}

async function cleanupOrg(organizationId: string): Promise<void> {
    const { data: accounts } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('organization_id', organizationId);
    for (const acc of accounts ?? []) {
        if (acc.vault_secret_id) {
            const { deleteAccountCredentials } = await import('../src/services/email/email-account-vault.js');
            await deleteAccountCredentials(acc.vault_secret_id as string);
        }
    }
    await supabaseAdmin.from('email_accounts').delete().eq('organization_id', organizationId);
    await supabaseAdmin.from('organizations').delete().eq('id', organizationId);
}

describe('src/services/email/email-account.service.ts', () => {
    let orgId: string;

    beforeAll(async () => {
        orgId = await createTestOrg(null);
    });

    afterAll(async () => {
        await cleanupOrg(orgId);
    });

    beforeEach(() => {
        imapShouldFail = false;
        smtpShouldFail = false;
        imapConnectCallCount = 0;
    });

    describe('validateAndSaveAccount', () => {
        it('rechaza con 400 si la organización no existe', async () => {
            const result = await validateAndSaveAccount(crypto.randomUUID(), buildConfig());
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.statusCode).toBe(400);
                expect(result.error).toContain('no existe');
            }
        });

        it('rechaza con 400 si la conexión IMAP falla, sin persistir nada', async () => {
            imapShouldFail = true;
            const config = buildConfig();
            const result = await validateAndSaveAccount(orgId, config);

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.statusCode).toBe(400);
                expect(result.error).toContain('IMAP');
            }

            const { data } = await supabaseAdmin.from('email_accounts').select('id').eq('organization_id', orgId).eq('email_address', config.emailAddress);
            expect(data?.length ?? 0).toBe(0);
        });

        it('rechaza con 400 si la conexión SMTP falla, sin persistir nada', async () => {
            smtpShouldFail = true;
            const config = buildConfig();
            const result = await validateAndSaveAccount(orgId, config);

            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.statusCode).toBe(400);
                expect(result.error).toContain('SMTP');
            }

            const { data } = await supabaseAdmin.from('email_accounts').select('id').eq('organization_id', orgId).eq('email_address', config.emailAddress);
            expect(data?.length ?? 0).toBe(0);
        });

        it('contraparte de éxito: crea el buzón, guarda credenciales cifradas en Vault y no expone contraseñas en la fila devuelta', async () => {
            const config = buildConfig();
            const result = await validateAndSaveAccount(orgId, config);

            expect(result.success).toBe(true);
            if (!result.success) return;

            expect(result.account.emailAddress).toBe(config.emailAddress);
            expect(result.account.status).toBe('active');
            expect(result.account).not.toHaveProperty('imapPassword');
            expect(result.account).not.toHaveProperty('smtpPassword');

            const { data: row } = await supabaseAdmin
                .from('email_accounts')
                .select('vault_secret_id')
                .eq('id', result.account.id)
                .single();
            expect(row?.vault_secret_id).toBeTruthy();

            const credentials = await getAccountCredentials(row!.vault_secret_id as string);
            if (credentials) {
                expect(credentials.imapPassword).toBe(config.imapPassword);
                expect(credentials.smtpPassword).toBe(config.smtpPassword);
            }
        });

        it('rechaza con 400 si ya existe un buzón con la misma dirección en la organización, sin intentar validar IMAP de nuevo', async () => {
            const config = buildConfig();
            const first = await validateAndSaveAccount(orgId, config);
            expect(first.success).toBe(true);

            imapConnectCallCount = 0;
            const second = await validateAndSaveAccount(orgId, config);
            expect(second.success).toBe(false);
            if (!second.success) {
                expect(second.statusCode).toBe(400);
                expect(second.error).toContain('Ya existe un buzón');
            }
            // La guarda "existing" corta ANTES de intentar la conexión IMAP —
            // si el mutante que la desactiva sobrevive, esta llamada innecesaria
            // sí ocurriría (aunque el resultado final termine siendo el mismo
            // 400 vía el 23505 de la restricción UNIQUE de la base).
            expect(imapConnectCallCount).toBe(0);
        });

        it('rechaza con 403 cuando se alcanza el límite de buzones del plan', async () => {
            const limitedOrgId = await createTestOrg(1);
            try {
                const first = await validateAndSaveAccount(limitedOrgId, buildConfig());
                expect(first.success).toBe(true);

                const second = await validateAndSaveAccount(limitedOrgId, buildConfig());
                expect(second.success).toBe(false);
                if (!second.success) {
                    expect(second.statusCode).toBe(403);
                    expect(second.error).toContain('límite');
                }
            } finally {
                await cleanupOrg(limitedOrgId);
            }
        });
    });

    describe('listAccounts', () => {
        it('devuelve las cuentas de la organización junto con maxMailboxes', async () => {
            const { accounts, maxMailboxes } = await listAccounts(orgId);
            expect(Array.isArray(accounts)).toBe(true);
            expect(maxMailboxes).toBeNull();
        });
    });

    describe('deleteAccount', () => {
        it('elimina la fila y las credenciales de Vault', async () => {
            const config = buildConfig();
            const created = await validateAndSaveAccount(orgId, config);
            expect(created.success).toBe(true);
            if (!created.success) return;

            const { data: rowBefore } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('id', created.account.id).single();
            const vaultSecretId = rowBefore!.vault_secret_id as string;

            const result = await deleteAccount(orgId, created.account.id);
            expect(result.success).toBe(true);

            const { data: rowAfter } = await supabaseAdmin.from('email_accounts').select('id').eq('id', created.account.id).maybeSingle();
            expect(rowAfter).toBeNull();

            const credentialsAfter = await getAccountCredentials(vaultSecretId);
            expect(credentialsAfter).toBeNull();
        });

        it('devuelve error si el buzón no existe', async () => {
            const result = await deleteAccount(orgId, crypto.randomUUID());
            expect(result.success).toBe(false);
        });
    });

    describe('aislamiento multi-tenant', () => {
        it('la organización B no puede leer ni desvincular el buzón de la organización A', async () => {
            const orgAId = await createTestOrg(null);
            const orgBId = await createTestOrg(null);

            try {
                const created = await validateAndSaveAccount(orgAId, buildConfig());
                expect(created.success).toBe(true);
                if (!created.success) return;

                const { accounts: orgBAccounts } = await listAccounts(orgBId);
                expect(orgBAccounts.find((a) => a.id === created.account.id)).toBeUndefined();

                const deleteAttempt = await deleteAccount(orgBId, created.account.id);
                expect(deleteAttempt.success).toBe(false);

                const { data: stillThere } = await supabaseAdmin.from('email_accounts').select('id').eq('id', created.account.id).maybeSingle();
                expect(stillThere).not.toBeNull();
            } finally {
                await cleanupOrg(orgAId);
                await cleanupOrg(orgBId);
            }
        });
    });

    /**
     * Ramas de fallo de infraestructura que no se pueden provocar de forma
     * confiable contra la base real (error de Supabase en la consulta de
     * cupo/listado/borrado, fallo de Vault al crear el secreto) — se
     * interceptan selectivamente con vi.spyOn sobre supabaseAdmin.from /
     * pg.Pool.prototype.query, dejando pasar las demás llamadas a la base
     * real (mismo criterio que __tests__/secret-service.test.ts).
     */
    describe('ramas de fallo de infraestructura', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('validateAndSaveAccount: retorna 400 con el mensaje exacto si la consulta de cupo de buzones falla', async () => {
            const limitedOrgId = await createTestOrg(2);
            try {
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi
                    .spyOn(supabaseAdmin, 'from')
                    .mockImplementationOnce(realFrom) // organizations
                    .mockImplementationOnce(
                        () =>
                            ({
                                select: () => ({ eq: () => Promise.resolve({ count: null, error: { message: 'conteo falló' } }) }),
                            }) as never
                    );

                const result = await validateAndSaveAccount(limitedOrgId, buildConfig());
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.statusCode).toBe(400);
                    expect(result.error).toBe('No se pudo verificar el cupo de buzones: conteo falló');
                }
                fromSpy.mockRestore();
            } finally {
                await cleanupOrg(limitedOrgId);
            }
        });

        it('validateAndSaveAccount: retorna 400 con el mensaje exacto si Vault no devuelve un id de secreto', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockImplementation(async (...args: unknown[]) => {
                    const sql = args[0];
                    if (typeof sql === 'string' && sql.includes('vault.create_secret')) {
                        return { rows: [], rowCount: 0 } as never;
                    }
                    throw new Error('unexpected query in this mocked path');
                });

                const result = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.statusCode).toBe(400);
                    expect(result.error).toBe('No se pudieron guardar las credenciales de forma segura. Intenta de nuevo.');
                }
                querySpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('validateAndSaveAccount: en conflicto de inserción (23505) revierte el secreto de Vault ya creado y responde 400', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            const deleteSpy = vi.mocked(deleteAccountCredentials);
            deleteSpy.mockClear(); // este vi.fn() es persistente para todo el archivo — se aísla el conteo a esta prueba
            try {
                const config = buildConfig();
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi
                    .spyOn(supabaseAdmin, 'from')
                    .mockImplementationOnce(realFrom) // organizations
                    .mockImplementationOnce(realFrom) // existing-address check
                    .mockImplementationOnce(
                        () =>
                            ({
                                insert: () => ({
                                    select: () => ({
                                        single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }),
                                    }),
                                }),
                            }) as never
                    );

                const result = await validateAndSaveAccount(dedicatedOrgId, config);
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.statusCode).toBe(400);
                    expect(result.error).toBe(`Ya existe un buzón vinculado con la dirección ${config.emailAddress} en esta organización.`);
                }
                expect(deleteSpy).toHaveBeenCalledTimes(1);
                const rolledBackVaultSecretId = deleteSpy.mock.calls[0][0];
                // El secreto realmente se borró de Vault (no quedó huérfano).
                expect(await getAccountCredentials(rolledBackVaultSecretId)).toBeNull();

                fromSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('validateAndSaveAccount: en error de inserción genérico (no 23505) responde 400 con el mensaje del error, y "error desconocido" si no trae message', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi
                    .spyOn(supabaseAdmin, 'from')
                    .mockImplementationOnce(realFrom)
                    .mockImplementationOnce(realFrom)
                    .mockImplementationOnce(
                        () =>
                            ({
                                insert: () => ({
                                    select: () => ({
                                        single: () => Promise.resolve({ data: null, error: { code: 'OTHER' } }),
                                    }),
                                }),
                            }) as never
                    );

                const result = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.statusCode).toBe(400);
                    expect(result.error).toBe('No se pudo guardar el buzón: error desconocido');
                }
                fromSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('listAccounts: lanza con el mensaje exacto si la consulta de buzones falla', async () => {
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom) // organizations
                .mockImplementationOnce(
                    () =>
                        ({
                            select: () => ({
                                eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'listado falló' } }) }),
                            }),
                        }) as never
                );

            await expect(listAccounts(crypto.randomUUID())).rejects.toThrow('Error listando buzones: listado falló');
            fromSpy.mockRestore();
        });

        it('listAccounts: accounts es [] cuando data llega null sin error (guard ?? [])', async () => {
            const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
            const fromSpy = vi
                .spyOn(supabaseAdmin, 'from')
                .mockImplementationOnce(realFrom)
                .mockImplementationOnce(
                    () =>
                        ({
                            select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }),
                        }) as never
                );

            const result = await listAccounts(crypto.randomUUID());
            expect(result.accounts).toEqual([]);
            fromSpy.mockRestore();
        });

        it('deleteAccount: retorna error con el mensaje exacto si el DELETE falla', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const created = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(created.success).toBe(true);
                if (!created.success) return;

                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi
                    .spyOn(supabaseAdmin, 'from')
                    .mockImplementationOnce(realFrom) // select (fetch account)
                    .mockImplementationOnce(
                        () =>
                            ({
                                delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'borrado falló' } }) }) }),
                            }) as never
                    );

                const result = await deleteAccount(dedicatedOrgId, created.account.id);
                expect(result).toEqual({ success: false, error: 'No se pudo desvincular el buzón: borrado falló' });
                fromSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });
    });

    describe('describeConnectionError', () => {
        it('registra un logger.warn con la forma exacta {err, protocol} al fallar la validación IMAP', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const loggerModule = await import('../src/lib/logger.js');
                const warnSpy = vi.spyOn(loggerModule.logger, 'warn');
                imapShouldFail = true;

                const result = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(result.success).toBe(false);
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ protocol: 'IMAP' }),
                    '[EmailAccountService] Fallo de validación de conexión'
                );
                warnSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('registra un logger.warn con protocol exacto "SMTP" (no "IMAP") al fallar la validación SMTP, con mensaje que menciona SMTP', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const loggerModule = await import('../src/lib/logger.js');
                const warnSpy = vi.spyOn(loggerModule.logger, 'warn');
                smtpShouldFail = true;

                const result = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(result.success).toBe(false);
                if (!result.success) {
                    expect(result.error).toBe(
                        'No se pudo validar la conexión SMTP con los datos proporcionados: No se pudo conectar al servidor SMTP: Simulated SMTP auth failure'
                    );
                }
                expect(warnSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ protocol: 'SMTP' }),
                    '[EmailAccountService] Fallo de validación de conexión'
                );
                warnSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });
    });

    describe('configuración exacta pasada a IMAP/SMTP/Vault', () => {
        it('verifyImapConnection recibe exactamente host/port/secure/user/pass del payload', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const config = buildConfig({ imapHost: 'imap.custom.test', imapPort: 143, imapSecure: false, imapUsername: 'user-x', imapPassword: 'pass-x' });
                await validateAndSaveAccount(dedicatedOrgId, config);
                expect(lastImapFlowConfig).toMatchObject({
                    host: 'imap.custom.test',
                    port: 143,
                    secure: false,
                    auth: { user: 'user-x', pass: 'pass-x' },
                });
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('verifySmtpConnection recibe exactamente host/port/secure/user/pass del payload', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const config = buildConfig({ smtpHost: 'smtp.custom.test', smtpPort: 587, smtpSecure: false, smtpUsername: 'user-y', smtpPassword: 'pass-y' });
                await validateAndSaveAccount(dedicatedOrgId, config);
                expect(lastSmtpTransportConfig).toMatchObject({
                    host: 'smtp.custom.test',
                    port: 587,
                    secure: false,
                    auth: { user: 'user-y', pass: 'pass-y' },
                });
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('storeAccountCredentials recibe exactamente imapPassword/smtpPassword del payload (verificado leyendo el secreto real de Vault)', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const config = buildConfig({ imapPassword: 'clave-imap-unica', smtpPassword: 'clave-smtp-unica' });
                const result = await validateAndSaveAccount(dedicatedOrgId, config);
                expect(result.success).toBe(true);
                if (!result.success) return;

                const { data: row } = await supabaseAdmin.from('email_accounts').select('vault_secret_id').eq('id', result.account.id).single();
                const credentials = await getAccountCredentials(row!.vault_secret_id as string);
                if (credentials) {
                    expect(credentials.imapPassword).toBe('clave-imap-unica');
                    expect(credentials.smtpPassword).toBe('clave-smtp-unica');
                }
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('providerLabel se guarda tal cual cuando se proporciona (no se descarta a null)', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const config = buildConfig({ providerLabel: 'gmail-personalizado' });
                const result = await validateAndSaveAccount(dedicatedOrgId, config);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.account.providerLabel).toBe('gmail-personalizado');
                }
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('providerLabel queda null cuando no se proporciona', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const config = buildConfig({ providerLabel: null });
                const result = await validateAndSaveAccount(dedicatedOrgId, config);
                expect(result.success).toBe(true);
                if (result.success) {
                    expect(result.account.providerLabel).toBeNull();
                }
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('no lanza y responde con "error desconocido" cuando insert() resuelve {data:null, error:null} (caso defensivo, no reproducible con Supabase real)', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi
                    .spyOn(supabaseAdmin, 'from')
                    .mockImplementationOnce(realFrom) // organizations
                    .mockImplementationOnce(realFrom) // existing-address check
                    .mockImplementationOnce(
                        () =>
                            ({
                                insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
                            }) as never
                    );

                await expect(validateAndSaveAccount(dedicatedOrgId, buildConfig())).resolves.toEqual({
                    success: false,
                    error: 'No se pudo guardar el buzón: error desconocido',
                    statusCode: 400,
                });
                fromSpy.mockRestore();
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });
    });

    describe('argumentos exactos de las consultas (columnas/filtros)', () => {
        it('validateAndSaveAccount usa exactamente las columnas y filtros esperados en cada consulta', async () => {
            const dedicatedOrgId = await createTestOrg(5); // no-null para ejercitar también la consulta de conteo
            try {
                const log: RecordedCall[] = [];
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => recordCalls(realFrom(table), log));

                const config = buildConfig();
                const result = await validateAndSaveAccount(dedicatedOrgId, config);
                expect(result.success).toBe(true);
                fromSpy.mockRestore();

                const selects = log.filter((c) => c.method === 'select').map((c) => c.args[0]);
                expect(selects).toContain('max_mailboxes'); // organizations lookup
                expect(selects).toContain('id'); // conteo de cupo + chequeo de dirección existente

                const countSelectCall = log.find((c) => c.method === 'select' && Array.isArray(c.args) && c.args.length > 1);
                expect(countSelectCall?.args).toEqual(['id', { count: 'exact', head: true }]);

                const eqOrgIdCalls = log.filter((c) => c.method === 'eq' && c.args[0] === 'organization_id');
                expect(eqOrgIdCalls.length).toBeGreaterThanOrEqual(2); // conteo + chequeo de dirección
                for (const call of eqOrgIdCalls) {
                    expect(call.args[1]).toBe(dedicatedOrgId);
                }

                const eqEmailCall = log.find((c) => c.method === 'eq' && c.args[0] === 'email_address');
                expect(eqEmailCall?.args).toEqual(['email_address', config.emailAddress]);
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('listAccounts usa exactamente select(id-tal-cual)/eq(organization_id)/order(created_at asc)', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const log: RecordedCall[] = [];
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => recordCalls(realFrom(table), log));

                await listAccounts(dedicatedOrgId);
                fromSpy.mockRestore();

                const orderCall = log.find((c) => c.method === 'order');
                expect(orderCall?.args).toEqual(['created_at', { ascending: true }]);

                const eqCall = log.find((c) => c.method === 'eq' && c.args[0] === 'organization_id');
                expect(eqCall?.args).toEqual(['organization_id', dedicatedOrgId]);
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });

        it('deleteAccount filtra por id Y organization_id en el SELECT (no solo en el DELETE)', async () => {
            const dedicatedOrgId = await createTestOrg(null);
            try {
                const created = await validateAndSaveAccount(dedicatedOrgId, buildConfig());
                expect(created.success).toBe(true);
                if (!created.success) return;

                const log: RecordedCall[] = [];
                const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
                const fromSpy = vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => recordCalls(realFrom(table), log));

                await deleteAccount(dedicatedOrgId, created.account.id);
                fromSpy.mockRestore();

                const selectEqCalls = log.filter((c) => c.method === 'eq');
                const hasIdFilter = selectEqCalls.some((c) => c.args[0] === 'id' && c.args[1] === created.account.id);
                const hasOrgFilter = selectEqCalls.some((c) => c.args[0] === 'organization_id' && c.args[1] === dedicatedOrgId);
                expect(hasIdFilter).toBe(true);
                expect(hasOrgFilter).toBe(true);
            } finally {
                await cleanupOrg(dedicatedOrgId);
            }
        });
    });
});
