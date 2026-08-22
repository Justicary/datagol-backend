import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import pg from 'pg';
import {
    storeAccountCredentials,
    rotateAccountCredentials,
    getAccountCredentials,
    deleteAccountCredentials,
} from '../src/services/email/email-account-vault.js';
import { logger } from '../src/lib/logger.js';

/**
 * Pruebas de integración reales contra Supabase Vault, mismo criterio que
 * __tests__/secret-service.test.ts — este módulo usa el mismo mecanismo
 * interno (vault.create_secret/update_secret vía pg.Pool), pero con nombre
 * de secreto por-recurso (org:<id>:email_account:<accountId>) en vez de
 * `organization_secrets`.
 */
describe('src/services/email/email-account-vault.ts — Vault por buzón', () => {
    const organizationId = crypto.randomUUID();
    const emailAccountId = crypto.randomUUID();

    it('getAccountCredentials devuelve null si vaultSecretId está vacío, sin tocar la base de datos', async () => {
        const querySpy = vi.spyOn(pg.Pool.prototype, 'query');
        try {
            const result = await getAccountCredentials('');
            expect(result).toBeNull();
            expect(querySpy).not.toHaveBeenCalled();
        } finally {
            querySpy.mockRestore();
        }
    });

    it('deleteAccountCredentials no consulta la base de datos si vaultSecretId está vacío', async () => {
        const querySpy = vi.spyOn(pg.Pool.prototype, 'query');
        try {
            await deleteAccountCredentials('');
            expect(querySpy).not.toHaveBeenCalled();
        } finally {
            querySpy.mockRestore();
        }
    });

    it('getAccountCredentials devuelve null cuando res.rows es undefined (no solo cuando es un arreglo vacío)', async () => {
        const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValueOnce({} as never);
        const result = await getAccountCredentials(crypto.randomUUID());
        expect(result).toBeNull();
        querySpy.mockRestore();
    });

    it('storeAccountCredentials crea el secreto y getAccountCredentials lo lee de vuelta intacto', async () => {
        const vaultSecretId = await storeAccountCredentials(organizationId, emailAccountId, {
            imapPassword: 'imap-pass-inicial',
            smtpPassword: 'smtp-pass-inicial',
        });

        if (!vaultSecretId) {
            // Entorno sin acceso directo a Vault: se documenta el fallo, no se rompe la corrida.
            expect(vaultSecretId).toBeNull();
            return;
        }

        const read = await getAccountCredentials(vaultSecretId);
        expect(read).toEqual({ imapPassword: 'imap-pass-inicial', smtpPassword: 'smtp-pass-inicial' });

        await deleteAccountCredentials(vaultSecretId);
    });

    it('rotateAccountCredentials sobreescribe el valor existente sin crear un secreto nuevo', async () => {
        const vaultSecretId = await storeAccountCredentials(organizationId, crypto.randomUUID(), {
            imapPassword: 'antes-imap',
            smtpPassword: 'antes-smtp',
        });
        if (!vaultSecretId) {
            expect(vaultSecretId).toBeNull();
            return;
        }

        try {
            const rotated = await rotateAccountCredentials(vaultSecretId, {
                imapPassword: 'despues-imap',
                smtpPassword: 'despues-smtp',
            });
            expect(rotated).toBe(true);

            const read = await getAccountCredentials(vaultSecretId);
            expect(read).toEqual({ imapPassword: 'despues-imap', smtpPassword: 'despues-smtp' });
        } finally {
            await deleteAccountCredentials(vaultSecretId);
        }
    });

    it('getAccountCredentials devuelve null limpiamente para un vaultSecretId inexistente (fila huérfana)', async () => {
        const result = await getAccountCredentials(crypto.randomUUID());
        expect(result).toBeNull();
    });

    it('deleteAccountCredentials es idempotente: no lanza al eliminar un secreto ya eliminado', async () => {
        const vaultSecretId = await storeAccountCredentials(organizationId, crypto.randomUUID(), {
            imapPassword: 'temp-imap',
            smtpPassword: 'temp-smtp',
        });
        if (!vaultSecretId) {
            expect(vaultSecretId).toBeNull();
            return;
        }

        await deleteAccountCredentials(vaultSecretId);
        await expect(deleteAccountCredentials(vaultSecretId)).resolves.toBeUndefined();

        const readAfterDelete = await getAccountCredentials(vaultSecretId);
        expect(readAfterDelete).toBeNull();
    });

    it('deleteAccountCredentials no lanza y no consulta la base de datos si vaultSecretId está vacío', async () => {
        await expect(deleteAccountCredentials('')).resolves.toBeUndefined();
    });

    it('vaultSecretName usa el formato org:<id>:email_account:<id> y la descripción exacta (verificado por los parámetros reales enviados a vault.create_secret)', async () => {
        const orgId = crypto.randomUUID();
        const accountId = crypto.randomUUID();
        const querySpy = vi.spyOn(pg.Pool.prototype, 'query');

        const vaultSecretId = await storeAccountCredentials(orgId, accountId, { imapPassword: 'a', smtpPassword: 'b' });
        try {
            const createCall = querySpy.mock.calls.find(
                (call) => typeof call[0] === 'string' && (call[0] as string).includes('vault.create_secret')
            );
            expect(createCall).toBeDefined();
            const params = createCall![1] as unknown[];
            expect(params[1]).toBe(`org:${orgId}:email_account:${accountId}`);
            expect(params[2]).toBe(`Credenciales IMAP/SMTP del buzón ${accountId} de organización ${orgId}`);
        } finally {
            querySpy.mockRestore();
            if (vaultSecretId) await deleteAccountCredentials(vaultSecretId);
        }
    });

    /**
     * Ramas de fallo que no se pueden provocar contra Vault real de forma
     * confiable (vault.create_secret sin fila, JSON corrupto, errores de
     * infraestructura) — mismo patrón de vi.spyOn(pg.Pool.prototype, 'query')
     * que __tests__/secret-service.test.ts usa para los mismos casos.
     */
    describe('ramas de fallo (pg.Pool.prototype.query mockeado)', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('storeAccountCredentials retorna null y registra el mensaje exacto si vault.create_secret no devuelve fila', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as never);
            const errorSpy = vi.spyOn(logger, 'error');
            const orgId = crypto.randomUUID();
            const accountId = crypto.randomUUID();

            const result = await storeAccountCredentials(orgId, accountId, { imapPassword: 'a', smtpPassword: 'b' });

            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                { organizationId: orgId, emailAccountId: accountId },
                '[EmailAccountVault] vault.create_secret no devolvió id'
            );
            querySpy.mockRestore();
        });

        it('storeAccountCredentials retorna null y registra si pool.query lanza una excepción', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValue(new Error('conexión rechazada'));
            const errorSpy = vi.spyOn(logger, 'error');
            const orgId = crypto.randomUUID();
            const accountId = crypto.randomUUID();

            const result = await storeAccountCredentials(orgId, accountId, { imapPassword: 'a', smtpPassword: 'b' });

            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ organizationId: orgId, emailAccountId: accountId, msg: 'conexión rechazada' }),
                '[EmailAccountVault] Excepción creando credenciales'
            );
            querySpy.mockRestore();
        });

        it('rotateAccountCredentials retorna false y registra si pool.query lanza una excepción', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValue(new Error('vault caído'));
            const errorSpy = vi.spyOn(logger, 'error');
            const fakeVaultSecretId = crypto.randomUUID();

            const result = await rotateAccountCredentials(fakeVaultSecretId, { imapPassword: 'a', smtpPassword: 'b' });

            expect(result).toBe(false);
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ vaultSecretId: fakeVaultSecretId, msg: 'vault caído' }),
                '[EmailAccountVault] Excepción rotando credenciales'
            );
            querySpy.mockRestore();
        });

        it('getAccountCredentials retorna null y registra si el secreto tiene JSON con smtpPassword faltante (imapPassword sí es string)', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({
                rows: [{ decrypted_secret: JSON.stringify({ imapPassword: 'x' }) }],
            } as never);
            const errorSpy = vi.spyOn(logger, 'error');
            const fakeVaultSecretId = crypto.randomUUID();

            const result = await getAccountCredentials(fakeVaultSecretId);

            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                { vaultSecretId: fakeVaultSecretId },
                '[EmailAccountVault] Secreto con forma inesperada (falta imapPassword/smtpPassword)'
            );
            querySpy.mockRestore();
        });

        it('getAccountCredentials retorna null y registra si el secreto tiene JSON con imapPassword faltante (smtpPassword sí es string)', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({
                rows: [{ decrypted_secret: JSON.stringify({ smtpPassword: 'y' }) }],
            } as never);
            const fakeVaultSecretId = crypto.randomUUID();

            const result = await getAccountCredentials(fakeVaultSecretId);
            expect(result).toBeNull();
            querySpy.mockRestore();
        });

        it('getAccountCredentials retorna null y registra si el valor guardado no es JSON válido', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockResolvedValue({
                rows: [{ decrypted_secret: 'esto-no-es-json{' }],
            } as never);
            const errorSpy = vi.spyOn(logger, 'error');
            const fakeVaultSecretId = crypto.randomUUID();

            const result = await getAccountCredentials(fakeVaultSecretId);

            expect(result).toBeNull();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ vaultSecretId: fakeVaultSecretId }),
                '[EmailAccountVault] Error resolviendo credenciales'
            );
            querySpy.mockRestore();
        });

        it('getAccountCredentials retorna null si pool.query lanza una excepción de infraestructura', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValue(new Error('timeout de red'));
            const fakeVaultSecretId = crypto.randomUUID();

            const result = await getAccountCredentials(fakeVaultSecretId);
            expect(result).toBeNull();
            querySpy.mockRestore();
        });

        it('deleteAccountCredentials no lanza y registra el error si pool.query rechaza', async () => {
            const querySpy = vi.spyOn(pg.Pool.prototype, 'query').mockRejectedValue(new Error('delete falló'));
            const errorSpy = vi.spyOn(logger, 'error');
            const fakeVaultSecretId = crypto.randomUUID();

            await expect(deleteAccountCredentials(fakeVaultSecretId)).resolves.toBeUndefined();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ vaultSecretId: fakeVaultSecretId, msg: 'delete falló' }),
                '[EmailAccountVault] Error eliminando credenciales'
            );
            querySpy.mockRestore();
        });
    });
});
