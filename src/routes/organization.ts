import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { insertKnowledgeChunk, searchKnowledgeBase } from '../services/rag.js';

interface CreateOrganizationBody {
    name: string;
    email?: string;
    phone_number?: string;
    vapi_agent_id?: string;
    address?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    latitude?: number;
    longitude?: number;
}

interface UpdateOrganizationBody {
    name?: string;
    email?: string;
    phone_number?: string;
    vapi_agent_id?: string;
    address?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    latitude?: number;
    longitude?: number;
}

interface OrganizationParams {
    id: string;
}

interface AddKnowledgeBody {
    title: string;
    content: string;
    metadata?: Record<string, any>;
}

interface SearchKnowledgeBody {
    query: string;
    limit?: number;
}

/**
 * Plugin de Fastify para la gestión de Organizaciones y Base de Conocimiento (RAG).
 */
export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
    /**
     * POST /api/organizations
     * Crea una nueva organización en Supabase incluyendo datos de ubicación/geolocalización.
     */
    fastify.post<{ Body: CreateOrganizationBody }>('/api/organizations', async (request, reply) => {
        try {
            const {
                name,
                email,
                phone_number,
                vapi_agent_id,
                address,
                city,
                state,
                postal_code,
                latitude,
                longitude,
            } = request.body || {};

            if (!name || typeof name !== 'string' || name.trim() === '') {
                return reply.status(400).send({
                    status: 'error',
                    message: 'El campo "name" es obligatorio y debe ser una cadena de texto válida.',
                });
            }

            const insertPayload: Record<string, any> = {
                name: name.trim(),
                email: email ?? null,
                phone_number: phone_number ?? null,
                vapi_agent_id: vapi_agent_id ?? null,
            };

            if (address !== undefined) insertPayload.address = address;
            if (city !== undefined) insertPayload.city = city;
            if (state !== undefined) insertPayload.state = state;
            if (postal_code !== undefined) insertPayload.postal_code = postal_code;
            if (latitude !== undefined) insertPayload.latitude = latitude;
            if (longitude !== undefined) insertPayload.longitude = longitude;

            const { data, error } = await supabaseAdmin
                .from('organizations')
                .insert(insertPayload)
                .select()
                .single();

            if (error) {
                return reply.status(500).send({
                    status: 'error',
                    message: 'Error al registrar la organización en Supabase',
                    details: error.message,
                });
            }

            return reply.status(201).send({
                status: 'success',
                message: 'Organización creada exitosamente',
                data,
            });
        } catch (err: any) {
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno del servidor al crear la organización',
            });
        }
    });

    /**
     * PUT /api/organizations/:id
     * Actualiza los datos de una organización existente en Supabase.
     */
    fastify.put<{ Params: OrganizationParams; Body: UpdateOrganizationBody }>(
        '/api/organizations/:id',
        async (request, reply) => {
            try {
                const { id } = request.params;
                const {
                    name,
                    email,
                    phone_number,
                    vapi_agent_id,
                    address,
                    city,
                    state,
                    postal_code,
                    latitude,
                    longitude,
                } = request.body || {};

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                const updatePayload: Record<string, any> = {
                    updated_at: new Date().toISOString(),
                };

                if (name !== undefined) updatePayload.name = name.trim();
                if (email !== undefined) updatePayload.email = email;
                if (phone_number !== undefined) updatePayload.phone_number = phone_number;
                if (vapi_agent_id !== undefined) updatePayload.vapi_agent_id = vapi_agent_id;
                if (address !== undefined) updatePayload.address = address;
                if (city !== undefined) updatePayload.city = city;
                if (state !== undefined) updatePayload.state = state;
                if (postal_code !== undefined) updatePayload.postal_code = postal_code;
                if (latitude !== undefined) updatePayload.latitude = latitude;
                if (longitude !== undefined) updatePayload.longitude = longitude;

                const { data, error } = await supabaseAdmin
                    .from('organizations')
                    .update(updatePayload)
                    .eq('id', id)
                    .select()
                    .single();

                if (error) {
                    return reply.status(500).send({
                        status: 'error',
                        message: 'Error al actualizar la organización en Supabase',
                        details: error.message,
                    });
                }

                return reply.status(200).send({
                    status: 'success',
                    message: 'Organización actualizada exitosamente',
                    data,
                });
            } catch (err: any) {
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno del servidor al actualizar la organización',
                });
            }
        }
    );

    /**
     * GET /api/organizations
     * Obtiene la lista de organizaciones registradas.
     */
    fastify.get('/api/organizations', async (request, reply) => {
        try {
            const { data, error } = await supabaseAdmin
                .from('organizations')
                .select('*');

            if (error) {
                return reply.status(500).send({
                    status: 'error',
                    message: 'Error al consultar las organizaciones en Supabase',
                    details: error.message,
                });
            }

            return reply.status(200).send({
                status: 'success',
                data,
            });
        } catch (err: any) {
            return reply.status(500).send({
                status: 'error',
                message: err.message || 'Error interno del servidor al listar organizaciones',
            });
        }
    });

    /**
     * POST /api/organizations/:id/knowledge
     * Agrega un nuevo documento/chunk a la base de conocimiento de una organización.
     */
    fastify.post<{ Params: OrganizationParams; Body: AddKnowledgeBody }>(
        '/api/organizations/:id/knowledge',
        async (request, reply) => {
            try {
                const { id } = request.params;
                const { title, content, metadata } = request.body || {};

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                if (!title || typeof title !== 'string' || title.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El campo "title" es obligatorio.',
                    });
                }

                if (!content || typeof content !== 'string' || content.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El campo "content" es obligatorio.',
                    });
                }

                const savedChunk = await insertKnowledgeChunk(id, title.trim(), content.trim(), metadata);

                return reply.status(201).send({
                    status: 'success',
                    message: 'Documento insertado correctamente en la base de conocimiento',
                    data: savedChunk,
                });
            } catch (err: any) {
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno al agregar el documento a la base de conocimiento',
                });
            }
        }
    );

    /**
     * POST /api/organizations/:id/knowledge/search
     * Realiza búsqueda semántica en la base de conocimiento de una organización.
     */
    fastify.post<{ Params: OrganizationParams; Body: SearchKnowledgeBody }>(
        '/api/organizations/:id/knowledge/search',
        async (request, reply) => {
            try {
                const { id } = request.params;
                const { query, limit = 5 } = request.body || {};

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                if (!query || typeof query !== 'string' || query.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El campo "query" es obligatorio.',
                    });
                }

                const parsedLimit = typeof limit === 'number' && limit > 0 ? limit : 5;
                const searchResults = await searchKnowledgeBase(id, query.trim(), parsedLimit);

                // Formatear resultados calculando el porcentaje de similitud
                const chunksWithSimilarity = (searchResults || []).map((item: any) => {
                    const rawSimilarity = item.similarity ?? item.similarity_score ?? 0;
                    const similarityPercentage = parseFloat((rawSimilarity * 100).toFixed(2));

                    return {
                        ...item,
                        similarity: rawSimilarity,
                        similarity_percentage: similarityPercentage,
                    };
                });

                return reply.status(200).send({
                    status: 'success',
                    data: chunksWithSimilarity,
                });
            } catch (err: any) {
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno al realizar la búsqueda en la base de conocimiento',
                });
            }
        }
    );

    /**
     * PATCH /api/organizations/:id/agent
     * Actualiza la configuración del agente e infraestructura VAPI en Supabase y Vapi API.
     */
    fastify.patch<{ Params: OrganizationParams; Body: any }>(
        '/api/organizations/:id/agent',
        async (request, reply) => {
            try {
                const { id } = request.params;
                const body = (request.body || {}) as any;

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                const updateData: any = {
                    vapi_first_message: body.firstMessage,
                    vapi_system_prompt: body.systemPrompt,
                    vapi_voice_id: body.voiceId,
                    updated_at: new Date().toISOString(),
                };

                if (body.vapiPrivateKey) updateData.vapi_private_key = body.vapiPrivateKey;
                if (body.vapiPhoneNumberId) updateData.vapi_phone_number_id = body.vapiPhoneNumberId;
                if (body.vapiAgentId) updateData.vapi_agent_id = body.vapiAgentId;

                // 1. Actualizar en Supabase
                const { data: org, error } = await supabaseAdmin
                    .from('organizations')
                    .update(updateData)
                    .eq('id', id)
                    .select('vapi_private_key, vapi_agent_id, vapi_phone_number_id')
                    .single();

                if (error) {
                    fastify.log.error(error, 'Error al actualizar en Supabase');
                    return reply.status(500).send({ error: error.message });
                }

                // 2. Sincronizar cambios en VAPI API usando la llave de la organización (o fallback)
                const apiKeyToUse = org?.vapi_private_key || body.vapiPrivateKey || process.env.VAPI_PRIVATE_KEY;
                const agentIdToUse = body.vapiAgentId || org?.vapi_agent_id || process.env.VAPI_AGENT_ID;

                if (agentIdToUse && apiKeyToUse) {
                    const vapiBody: any = {};
                    if (body.firstMessage !== undefined) vapiBody.firstMessage = body.firstMessage;
                    if (body.systemPrompt !== undefined) {
                        vapiBody.model = {
                            provider: 'openai',
                            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                            messages: [{ role: 'system', content: body.systemPrompt }],
                        };
                    }
                    if (body.voiceId !== undefined) {
                        vapiBody.voice = {
                            provider: '11labs',
                            voiceId: body.voiceId,
                        };
                    }

                    try {
                        await fetch(`https://api.vapi.ai/assistant/${agentIdToUse}`, {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${apiKeyToUse}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(vapiBody),
                        });
                    } catch (vapiErr: any) {
                        fastify.log.warn({ error: vapiErr.message }, '⚠️ No se pudo sincronizar directamente con Vapi API');
                    }
                }

                return reply.send({ status: 'success', message: 'Organización e Infraestructura VAPI actualizadas correctamente' });
            } catch (err: any) {
                fastify.log.error(err, 'Error en PATCH /api/organizations/:id/agent');
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno al actualizar la organización e infraestructura VAPI',
                });
            }
        }
    );

    /**
     * GET /api/organizations/:id/agent
     * Obtiene la configuración real del asistente directamente desde la API de Vapi (Source of Truth).
     */
    fastify.get<{ Params: OrganizationParams }>(
        '/api/organizations/:id/agent',
        async (request, reply) => {
            try {
                const { id } = request.params;

                if (!id || typeof id !== 'string' || id.trim() === '') {
                    return reply.status(400).send({
                        status: 'error',
                        message: 'El parámetro de ruta "id" es obligatorio.',
                    });
                }

                // 1. Obtener vapi_agent_id desde Supabase
                const { data: org, error: dbErr } = await supabaseAdmin
                    .from('organizations')
                    .select('vapi_agent_id')
                    .eq('id', id)
                    .maybeSingle();

                const targetVapiAgentId = org?.vapi_agent_id || process.env.VAPI_AGENT_ID;

                if (dbErr || !targetVapiAgentId) {
                    return reply.status(404).send({
                        status: 'error',
                        message: 'Organización o Agente Vapi no encontrado',
                    });
                }

                const vapiPrivateKey = process.env.VAPI_PRIVATE_KEY;

                if (!vapiPrivateKey) {
                    return reply.status(500).send({
                        status: 'error',
                        message: 'Falta configurar VAPI_PRIVATE_KEY en el servidor.',
                    });
                }

                // 2. Consultar directamente a Vapi API (Source of Truth)
                const vapiRes = await fetch(`https://api.vapi.ai/assistant/${targetVapiAgentId.trim()}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${vapiPrivateKey.trim()}`,
                        'Content-Type': 'application/json',
                    },
                });

                if (!vapiRes.ok) {
                    const errText = await vapiRes.text();
                    fastify.log.error({ status: vapiRes.status, error: errText }, 'Error al consultar la configuración en Vapi API');
                    return reply.status(vapiRes.status).send({
                        status: 'error',
                        message: 'Error al consultar la configuración en Vapi API',
                        details: errText,
                    });
                }

                const vapiAgent = (await vapiRes.json()) as {
                    id: string;
                    firstMessage?: string;
                    model?: {
                        messages?: Array<{ role: string; content: string }>;
                        systemPrompt?: string;
                    };
                    voice?: {
                        voiceId?: string;
                    };
                };

                const systemMessage = vapiAgent.model?.messages?.find((m) => m.role === 'system');
                const systemPromptContent = systemMessage?.content || vapiAgent.model?.systemPrompt || '';

                return reply.send({
                    status: 'success',
                    data: {
                        vapiAgentId: vapiAgent.id,
                        firstMessage: vapiAgent.firstMessage || '',
                        systemPrompt: systemPromptContent,
                        voiceId: vapiAgent.voice?.voiceId || 'cgSgspJ2msm6clMCkdW9',
                    },
                });
            } catch (err: any) {
                fastify.log.error(err, 'Error en GET /api/organizations/:id/agent');
                return reply.status(500).send({
                    status: 'error',
                    message: err.message || 'Error interno al consultar el agente en Vapi API',
                });
            }
        }
    );

    /**
     * POST /api/organizations/onboard
     * Ejecuta la creación atómica del cliente con soporte de WhatsApp, Vapi.ai y Base de Conocimiento RAG.
     */
    fastify.post('/api/organizations/onboard', async (request, reply) => {
        const body = (request.body || {}) as any;

        try {
            // 0. Verificación previa de seguridad server-side
            const { count, error: countErr } = await supabaseAdmin
                .from('organizations')
                .select('*', { count: 'exact', head: true });

            if (!countErr && count && count > 0) {
                return reply.status(400).send({
                    status: 'error',
                    message: 'Operación denegada: Ya existe una organización registrada en la base de datos.'
                });
            }

            // 1. Insertar Organización en Supabase DB (incluyendo campos opcionales de WhatsApp)
            const insertPayload: Record<string, any> = {
                name: body.name,
                contact_name: body.contactName ?? null,
                email: body.email ?? null,
                phone_number: body.phoneNumber ?? null,
                vapi_private_key: body.vapiPrivateKey || null,
                vapi_phone_number_id: body.vapiPhoneNumberId || null,
                vapi_first_message: body.firstMessage ?? null,
                vapi_system_prompt: body.systemPrompt ?? null,
                vapi_voice_id: body.voiceId ?? null,
                whatsapp_access_token: body.enableWhatsApp ? (body.whatsappAccessToken || null) : null,
                whatsapp_phone_number_id: body.enableWhatsApp ? (body.whatsappPhoneNumberId || null) : null,
                whatsapp_business_account_id: body.enableWhatsApp ? (body.whatsappBusinessAccountId || null) : null,
                widget_primary_color: body.widgetPrimaryColor || '#06b6d4'
            };

            let orgData: any = null;
            let orgError: any = null;

            const res = await supabaseAdmin
                .from('organizations')
                .insert(insertPayload)
                .select('*')
                .single();

            orgData = res.data;
            orgError = res.error;

            // Fallback si algunas columnas opcionales (ej: whatsapp_*) no existen en la tabla
            if (orgError && (
                orgError.message.includes('whatsapp') ||
                orgError.message.includes('contact_name') ||
                orgError.message.includes('widget_primary_color') ||
                orgError.message.includes('vapi_')
            )) {
                fastify.log.warn({ error: orgError.message }, '⚠️ Fallback en onboarding: insertando campos esenciales de organización...');
                const fallbackRes = await supabaseAdmin
                    .from('organizations')
                    .insert({
                        name: body.name,
                        email: body.email ?? null,
                        phone_number: body.phoneNumber ?? null,
                        vapi_private_key: body.vapiPrivateKey || null,
                        vapi_phone_number_id: body.vapiPhoneNumberId || null,
                        vapi_first_message: body.firstMessage ?? null,
                        vapi_system_prompt: body.systemPrompt ?? null,
                        vapi_voice_id: body.voiceId ?? null,
                    })
                    .select('*')
                    .single();

                orgData = fallbackRes.data;
                orgError = fallbackRes.error;
            }

            if (orgError || !orgData) {
                throw new Error(`Error en Supabase: ${orgError?.message || 'No se pudo crear la organización'}`);
            }

            const org = orgData;

            // 2. Registrar Asistente en la API de VAPI.ai
            const vapiApiKey = body.vapiPrivateKey || process.env.VAPI_PRIVATE_KEY;
            let vapiData: any = null;

            if (vapiApiKey) {
                try {
                    const vapiRes = await fetch('https://api.vapi.ai/assistant', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${vapiApiKey.trim()}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            name: `Recepcionista - ${body.name}`,
                            firstMessage: body.firstMessage,
                            model: {
                                provider: 'openai',
                                model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
                                messages: [{ role: 'system', content: body.systemPrompt }]
                            },
                            voice: {
                                provider: '11labs',
                                voiceId: body.voiceId || 'cgSgspJ2msm6clMCkdW9'
                            }
                        })
                    });

                    vapiData = await vapiRes.json() as any;

                    if (vapiRes.ok && vapiData?.id) {
                        // 3. Vincular vapi_agent_id generado en Supabase
                        await supabaseAdmin
                            .from('organizations')
                            .update({ vapi_agent_id: vapiData.id })
                            .eq('id', org.id);
                    } else {
                        fastify.log.warn({ vapiData }, '⚠️ No se pudo registrar automáticamente el asistente en Vapi API');
                    }
                } catch (vapiErr: any) {
                    fastify.log.warn({ error: vapiErr.message }, '⚠️ Excepción al conectar con Vapi API en onboarding');
                }
            }

            // 4. Ingestar Base de Conocimiento Inicial si se proporcionó
            if (body.initialKnowledge && typeof body.initialKnowledge === 'string' && body.initialKnowledge.trim() !== '') {
                try {
                    await insertKnowledgeChunk(
                        org.id,
                        'Preguntas Frecuentes Iniciales',
                        body.initialKnowledge.trim()
                    );
                    fastify.log.info({ orgId: org.id }, '✅ Base de conocimiento inicial ingestada correctamente');
                } catch (ragErr: any) {
                    fastify.log.warn({ error: ragErr.message }, '⚠️ No se pudo ingestar la base de conocimiento inicial');
                }
            }

            return reply.send({
                status: 'success',
                message: 'Organización e Infraestructura Omnicanal desplegadas correctamente',
                organization: {
                    ...org,
                    vapi_agent_id: vapiData?.id || org.vapi_agent_id || null
                }
            });

        } catch (err: any) {
            console.error('❌ Error en Onboarding:', err);
            return reply.status(500).send({ status: 'error', message: err.message });
        }
    });
};

export default organizationRoutes;
