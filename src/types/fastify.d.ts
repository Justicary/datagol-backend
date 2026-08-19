import { SupabaseClient } from '@supabase/supabase-js';
import { PgBoss } from 'pg-boss';

declare module 'fastify' {
    interface FastifyInstance {
        supabaseAdmin: SupabaseClient;
        supabaseUser: (userJwt: string) => SupabaseClient;
        pgBoss: PgBoss;
    }

    interface FastifyRequest {
        tenantId?: string;
        features?: Set<string>;
        rawBody?: string;
        permissions?: Set<string>;
        authUser?: { userId: string; jwt: string };
        platformAdminUserId?: string;
    }
}
