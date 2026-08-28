import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';

/**
 * Pares de llaves Ed25519 reales, generados una sola vez por proceso de
 * pruebas, para ejercitar los módulos de firma de este repositorio de
 * punta a punta sin depender de ningún secreto real. `key_version` fijo en
 * 'v1' — suficiente para las pruebas que no versionan llaves explícitamente.
 * Licencias (`lib/license-signing.ts`) y pase de superadmin
 * (`lib/admin-passport.ts`) usan pares SEPARADOS a propósito — mismo
 * aislamiento que el código de producción.
 */
let cachedLicenseKeys: { privatePem: string; publicPem: string } | null = null;
let cachedAdminPassportKeys: { privatePem: string; publicPem: string } | null = null;

async function generateEd25519Pair(): Promise<{ privatePem: string; publicPem: string }> {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const privatePem = await exportPKCS8(privateKey);
    const publicPem = await exportSPKI(publicKey);
    return { privatePem, publicPem };
}

export async function getTestLicenseKeyPair(): Promise<{ privatePem: string; publicPem: string }> {
    if (cachedLicenseKeys) return cachedLicenseKeys;
    cachedLicenseKeys = await generateEd25519Pair();
    return cachedLicenseKeys;
}

export async function setTestLicenseKeyEnv(keyVersion = 'v1'): Promise<void> {
    const { privatePem, publicPem } = await getTestLicenseKeyPair();
    process.env.CONTROL_PLANE_SIGNING_KEYS = JSON.stringify({ [keyVersion]: privatePem });
    process.env.LICENSE_PUBLIC_KEYS = JSON.stringify({ [keyVersion]: publicPem });
}

export async function getTestAdminPassportKeyPair(): Promise<{ privatePem: string; publicPem: string }> {
    if (cachedAdminPassportKeys) return cachedAdminPassportKeys;
    cachedAdminPassportKeys = await generateEd25519Pair();
    return cachedAdminPassportKeys;
}

export async function setTestAdminPassportKeyEnv(keyVersion = 'v1'): Promise<void> {
    const { privatePem, publicPem } = await getTestAdminPassportKeyPair();
    process.env.ADMIN_PASSPORT_SIGNING_KEYS = JSON.stringify({ [keyVersion]: privatePem });
    process.env.ADMIN_PASSPORT_PUBLIC_KEYS = JSON.stringify({ [keyVersion]: publicPem });
}
