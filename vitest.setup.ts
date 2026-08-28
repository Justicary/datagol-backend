import { setTestLicenseKeyEnv, setTestAdminPassportKeyEnv } from './__tests__/helpers/test-license-keys.js';

/**
 * Se ejecuta antes de que cada archivo de prueba importe nada — a
 * diferencia de un `beforeAll` dentro del propio archivo, esto corre antes
 * de que `src/lib/supabase.ts` (que llama a `validateEnv()` en su nivel de
 * módulo) se resuelva por primera vez. Sin esto, cualquier prueba que
 * importe estáticamente una ruta de `/control/**` o `services/license-*`
 * quedaría con `CONTROL_PLANE_SIGNING_KEYS`/`LICENSE_PUBLIC_KEYS`/
 * `ADMIN_PASSPORT_SIGNING_KEYS` ausentes cacheados para siempre en ese
 * archivo (docs/tasks/control-plane-backend-datagol.md).
 *
 * No fija `CONTROL_PLANE=true` — eso queda a cada prueba que lo necesite
 * (ver __tests__/control-plane-flag-isolation.test.ts), para no alterar el
 * comportamiento por defecto del resto de la suite.
 */
if (!process.env.CONTROL_PLANE_SIGNING_KEYS || !process.env.LICENSE_PUBLIC_KEYS) {
    await setTestLicenseKeyEnv('v1');
}
if (!process.env.ADMIN_PASSPORT_SIGNING_KEYS || !process.env.ADMIN_PASSPORT_PUBLIC_KEYS) {
    await setTestAdminPassportKeyEnv('v1');
}
