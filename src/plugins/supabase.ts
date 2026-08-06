import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { validateEnv } from '../config/env.js';

/**
 * Plugin de Fastify que registra los clientes de Supabase como decoradores.
 * - `fastify.supabaseAdmin`: usa service_role (SUPABASE_SECRET_KEY). Bypass de RLS.
 * - `fastify.supabaseUser(jwt)`: crea un cliente con el JWT del usuario final para respetar RLS en routes/admin/**.
 */
const supabasePluginCallback: FastifyPluginAsync = async (fastify) => {
    const env = validateEnv();

    const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
        },
    });

    const supabaseUserFactory = (userJwt: string): SupabaseClient => {
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
    };

    fastify.decorate('supabaseAdmin', supabaseAdmin);
    fastify.decorate('supabaseUser', supabaseUserFactory);
};

export const supabasePlugin = fp(supabasePluginCallback, {
    name: 'supabase-plugin',
});

export default supabasePlugin;
