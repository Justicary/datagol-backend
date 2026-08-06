import { createClient } from '@supabase/supabase-js';
import { validateEnv } from '../config/env.js';

const env = validateEnv();

/**
 * Cliente de Supabase con privilegios administrativos (service_role).
 * Nota: En el contexto de Fastify, se recomienda usar el decorador `fastify.supabaseAdmin`.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
    },
});

export function createSupabaseUserClient(userJwt: string) {
    const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_SECRET_KEY;
    return createClient(env.SUPABASE_URL, key, {
        global: {
            headers: {
                Authorization: `Bearer ${userJwt}`,
            },
        },
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });
}