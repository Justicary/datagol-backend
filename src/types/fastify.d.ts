import { SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';
import type { LicenseState, LicenseDegradationStage } from '../lib/license-degradation.js';

declare module 'fastify' {
    interface FastifyInstance {
        supabaseAdmin: SupabaseClient;
        supabaseUser: (userJwt: string) => SupabaseClient;
        pgBoss: PgBoss;
        /** Fase B — estado de licencia verificado localmente al arrancar y refrescado cada hora. */
        license: LicenseState;
    }

    interface FastifyRequest {
        tenantId?: string;
        features?: Set<string>;
        rawBody?: string;
        permissions?: Set<string>;
        authUser?: { userId: string; jwt: string };
        platformAdminUserId?: string;
        /** Email del superadmin autenticado — vía Supabase Auth o vía sesión local derivada de un pase (lib/admin-session.ts). */
        platformAdminEmail?: string;
        /** Etapa de degradación resuelta a partir de `fastify.license` al momento de la petición. */
        licenseStage?: LicenseDegradationStage;
    }
}
