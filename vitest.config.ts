import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['__tests__/**/*.test.ts'],
        globals: false,
        testTimeout: 30_000,
        // Varios archivos comparten la misma organización real (REAL_ORG_ID) y
        // mutan `organizations.webhook_token` / `organization_secrets` sobre esa
        // fila en beforeAll/afterAll. Con archivos en paralelo, esas escrituras
        // se pisan entre sí y producen 401 intermitentes en las rutas de tools.
        fileParallelism: false,
    },
});
