import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { VoiceProviderFactory } from '../services/providers/VoiceProviderFactory.js';
import { normalizePhoneE164 } from '../services/phone-normalization.js';
import { LEAD_CHANNELS } from '../types/lead-enums.js';

// Política acordada con el usuario (docs/tasks/outbound-lead-persistence-and-rate-limit.md,
// Problema 2): 3 llamadas/hora por IP de origen, 2 llamadas/día al mismo
// número marcado. Cuenta también los intentos que fallan — un atacante no
// debe poder reintentar sin límite solo porque un intento anterior fue
// rechazado.
const IP_RATE_LIMIT = 3;
const IP_RATE_WINDOW_MS = 60 * 60 * 1000;
const PHONE_RATE_LIMIT = 2;
const PHONE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function resolveSourceIp(request: any): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstIp = raw ? String(raw).split(',')[0].trim() : '';
  return firstIp || request.ip;
}

export const voiceRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /api/voice/outbound, POST /api/vapi/outbound y POST /api/vapi/call
   * Dispara una llamada saliente utilizando el proveedor de voz configurado (ElevenLabs ConvAI o Vapi Fallback).
   */
  const handleVoiceOutbound = async (request: any, reply: any) => {
    const body = (request.body || {}) as any;
    const organizationId = body.organizationId || body.orgId;
    const rawPhone = body.customerPhone || body.phone || body.number || body.customer?.number;
    const customerName = body.customerName || body.name || body.customer?.name || 'Cliente Prospecto';
    const customerEmail = body.customerEmail || body.email || body.customer?.email;
    const companyName = body.companyName || 'Empresa Prospecto';
    const businessSector = body.industry || body.businessSector;
    const demoObjective = body.demoObjective || 'Probar agente de voz en vivo';

    if (!rawPhone) {
      return reply.status(400).send({
        status: 'error',
        message: 'El campo número de teléfono (customerPhone) es obligatorio.',
      });
    }

    const phone = String(rawPhone).startsWith('+') ? String(rawPhone) : `+${rawPhone}`;
    const normalizedTarget = normalizePhoneE164(phone);
    const phoneKey = normalizedTarget.success ? (normalizedTarget.phoneE164 as string) : phone;
    const sourceIp = resolveSourceIp(request);

    const [{ count: phoneAttempts }, { count: ipAttempts }] = await Promise.all([
      supabaseAdmin
        .from('outbound_call_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('target_phone_raw', phoneKey)
        .gte('created_at', new Date(Date.now() - PHONE_RATE_WINDOW_MS).toISOString()),
      supabaseAdmin
        .from('outbound_call_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('source_ip', sourceIp)
        .gte('created_at', new Date(Date.now() - IP_RATE_WINDOW_MS).toISOString()),
    ]);

    if ((phoneAttempts || 0) >= PHONE_RATE_LIMIT) {
      return reply.status(429).send({
        status: 'error',
        message: 'Este número ya alcanzó el límite de llamadas permitidas hoy.',
      });
    }

    if ((ipAttempts || 0) >= IP_RATE_LIMIT) {
      return reply.status(429).send({
        status: 'error',
        message: 'Demasiadas solicitudes de llamada desde este origen.',
      });
    }

    await supabaseAdmin.from('outbound_call_attempts').insert({
      organization_id: organizationId || null,
      target_phone_raw: phoneKey,
      source_ip: sourceIp,
    });

    let orgConfig: Record<string, unknown> = {};

    if (organizationId) {
      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('*')
        .eq('id', organizationId)
        .maybeSingle();

      if (org) orgConfig = org;
    }

    // Resolver proveedor activo ('elevenlabs' o 'vapi', o el configurado en body / org / env)
    const activeProviderType =
      body.provider ||
      (orgConfig.active_voice_provider as string) ||
      process.env.DEFAULT_VOICE_PROVIDER ||
      'elevenlabs';

    const provider = VoiceProviderFactory.getProvider(activeProviderType);

    try {
      const result = await provider.triggerOutboundCall(
        {
          organizationId: organizationId || 'default',
          customerPhone: phone,
          customerName: String(customerName),
          customerEmail: customerEmail ? String(customerEmail) : undefined,
          companyName: String(companyName),
          businessSector: businessSector ? String(businessSector) : undefined,
          demoObjective: String(demoObjective),
          customVariables: body.customVariables || body.assistantOverrides?.variableValues,
        },
        orgConfig
      );

      // Siembra inmediata de contacts/call_logs/leads con los datos confiables
      // del formulario, en cuanto ElevenLabs confirma el conversation_id — no
      // espera al webhook de post-llamada, que solo persiste lo que el agente
      // vuelve a preguntar en voz (docs/tasks/outbound-lead-persistence-and-rate-limit.md,
      // Problema 1). El webhook real, cuando llegue, fusiona sobre esta
      // siembra vía el ON CONFLICT DO UPDATE de process_call_completed
      // (migración 13) sin perder temperature/booked_appointment/needs_followup.
      if (organizationId) {
        try {
          const { error: seedError } = await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: organizationId,
            p_conversation_id: result.callId,
            p_provider_call_id: result.callId,
            p_caller_phone_e164: normalizedTarget.success ? normalizedTarget.phoneE164 : null,
            p_full_name: String(customerName),
            p_email: customerEmail ? String(customerEmail) : null,
            p_business_name: String(companyName),
            p_business_sector: businessSector ? String(businessSector) : null,
            p_contact_phone_raw: phone,
            p_inquiry_reason: String(demoObjective),
            p_temperature: null,
            p_booked_appointment: false,
            p_needs_followup: false,
            p_followup_notes: null,
            p_call_volume: null,
            p_transcript: null,
            p_summary: null,
            p_duration_seconds: 0,
            p_usage_entries: [],
            p_channel: LEAD_CHANNELS.VOICE,
          });
          if (seedError) {
            request.log.error(
              { err: seedError, conversationId: result.callId, organizationId },
              'No se pudo sembrar el lead inicial de la llamada saliente con los datos del formulario'
            );
          }
        } catch (seedErr: any) {
          // La llamada real de ElevenLabs ya se disparó y cuesta dinero de
          // cualquier forma — un error al sembrar el lead no debe tumbar la
          // respuesta al frontend.
          request.log.error(
            { err: seedErr, conversationId: result.callId, organizationId },
            'Error inesperado al sembrar el lead inicial de la llamada saliente'
          );
        }
      }

      return reply.send({
        status: 'success',
        message: `Llamada saliente enviada a cola vía ${result.provider}`,
        data: result,
      });
    } catch (err: any) {
      request.log.error({ err }, 'Error en dispatch de llamada saliente');
      return reply.status(500).send({
        status: 'error',
        message: err.message || 'Error interno en dispatch de llamada saliente.',
      });
    }
  };

  fastify.post('/api/voice/outbound', handleVoiceOutbound);
  fastify.post('/api/vapi/outbound', handleVoiceOutbound);
  fastify.post('/api/vapi/call', handleVoiceOutbound);

  /**
   * GET /api/voice/agent
   * Obtiene la configuración activa del agente de voz de forma agnóstica al proveedor.
   */
  fastify.get('/api/voice/agent', async (request, reply) => {
    const query = (request.query || {}) as any;
    const organizationId = query.organizationId || query.orgId;

    let orgConfig: Record<string, unknown> = {};
    if (organizationId) {
      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('*')
        .eq('id', organizationId)
        .maybeSingle();
      if (org) orgConfig = org;
    }

    const activeProviderType =
      query.provider ||
      (orgConfig.active_voice_provider as string) ||
      process.env.DEFAULT_VOICE_PROVIDER ||
      'elevenlabs';

    const provider = VoiceProviderFactory.getProvider(activeProviderType);
    const agentId =
      (orgConfig.elevenlabs_agent_id as string) ||
      (orgConfig.vapi_agent_id as string) ||
      process.env.ELEVENLABS_AGENT_ID ||
      process.env.VAPI_AGENT_ID ||
      '';

    try {
      let config = {
        agentId,
        firstMessage: (orgConfig.vapi_first_message as string) || '¡Hola! ¿En qué le puedo atender hoy?',
        systemPrompt: (orgConfig.vapi_system_prompt as string) || 'Eres un asistente virtual amable.',
        voiceId: (orgConfig.vapi_voice_id as string) || 'Paulina',
      };

      if (typeof provider.getAgentConfig === 'function' && agentId) {
        const fetchedConfig = await provider.getAgentConfig(agentId);
        config = { ...config, ...fetchedConfig };
      }

      return reply.send({
        status: 'success',
        data: {
          provider: activeProviderType,
          ...config,
        },
      });
    } catch (err: any) {
      request.log.error({ err }, 'Error al obtener configuración del agente');
      return reply.status(500).send({
        status: 'error',
        message: err.message || 'Error al obtener la configuración del agente de voz.',
      });
    }
  });

  /**
   * PATCH /api/voice/agent
   * Actualiza la configuración del agente de voz en el proveedor activo y en Supabase.
   */
  fastify.patch('/api/voice/agent', async (request, reply) => {
    const body = (request.body || {}) as any;
    const organizationId = body.organizationId || body.orgId;
    const { firstMessage, systemPrompt, voiceId, provider: requestedProvider } = body;

    let orgConfig: Record<string, unknown> = {};
    if (organizationId) {
      const { data: org } = await supabaseAdmin
        .from('organizations')
        .select('*')
        .eq('id', organizationId)
        .maybeSingle();
      if (org) orgConfig = org;
    }

    const activeProviderType =
      requestedProvider ||
      (orgConfig.active_voice_provider as string) ||
      process.env.DEFAULT_VOICE_PROVIDER ||
      'elevenlabs';

    const provider = VoiceProviderFactory.getProvider(activeProviderType);

    try {
      if (typeof provider.syncAgentConfig === 'function') {
        await provider.syncAgentConfig(
          organizationId || 'default',
          {
            firstMessage,
            systemPrompt,
            voiceId,
          },
          orgConfig
        );
      }

      // Actualizar en Supabase si se pasó una organización
      if (organizationId) {
        const updatePayload: Record<string, unknown> = {};
        if (firstMessage !== undefined) updatePayload.vapi_first_message = firstMessage;
        if (systemPrompt !== undefined) updatePayload.vapi_system_prompt = systemPrompt;
        if (voiceId !== undefined) updatePayload.vapi_voice_id = voiceId;

        if (Object.keys(updatePayload).length > 0) {
          await supabaseAdmin
            .from('organizations')
            .update(updatePayload)
            .eq('id', organizationId);
        }
      }

      return reply.send({
        status: 'success',
        message: `Configuración de agente actualizada exitosamente en el proveedor '${activeProviderType}'.`,
      });
    } catch (err: any) {
      request.log.error({ err }, 'Error al actualizar la configuración del agente');
      return reply.status(500).send({
        status: 'error',
        message: err.message || 'Error al actualizar la configuración del agente de voz.',
      });
    }
  });

  /**
   * GET /api/voice/metrics
   * Calcula las métricas agregadas de la tabla call_logs en Supabase.
   */
  fastify.get('/api/voice/metrics', async (request, reply) => {
    const query = (request.query || {}) as any;
    const organizationId = query.organizationId || query.orgId;

    try {
      let dbQuery = supabaseAdmin.from('call_logs').select('*');

      if (organizationId) {
        dbQuery = dbQuery.eq('organization_id', organizationId);
      }

      const { data: logs, error } = await dbQuery;

      if (error) {
        throw new Error(error.message);
      }

      const callList = logs || [];
      const totalCalls = callList.length;

      let totalSeconds = 0;
      let accumulatedCost = 0;
      let successfulCalls = 0;
      const sentimentBreakdown = {
        positive: 0,
        neutral: 0,
        negative: 0,
      };

      for (const log of callList) {
        const dur = Number(log.duration_seconds || log.call_duration_secs || 0);
        totalSeconds += dur;

        const cost = Number(log.cost || 0);
        accumulatedCost += cost;

        const sentiment = String(log.sentiment || 'neutral').toLowerCase();
        if (sentiment.includes('positiv')) {
          sentimentBreakdown.positive++;
        } else if (sentiment.includes('negativ')) {
          sentimentBreakdown.negative++;
        } else {
          sentimentBreakdown.neutral++;
        }

        const isSuccess =
          log.status === 'completed' ||
          log.call_successful === true ||
          log.call_successful === 'true' ||
          !sentiment.includes('negativ');

        if (isSuccess) {
          successfulCalls++;
        }
      }

      const totalMinutes = Math.round((totalSeconds / 60) * 10) / 10;
      const successRate = totalCalls > 0 ? Math.round((successfulCalls / totalCalls) * 100) : 0;
      const roundedCost = Math.round(accumulatedCost * 10000) / 10000;

      return reply.send({
        status: 'success',
        data: {
          totalCalls,
          successfulCalls,
          successRate,
          totalMinutes,
          accumulatedCost: roundedCost,
          sentimentBreakdown,
        },
      });
    } catch (err: any) {
      request.log.error({ err }, 'Error al calcular métricas de llamadas');
      return reply.status(500).send({
        status: 'error',
        message: err.message || 'Error al calcular las métricas de llamadas de voz.',
      });
    }
  });
};

export default voiceRoutes;
