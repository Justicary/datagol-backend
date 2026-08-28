import { FastifyPluginAsync } from 'fastify';
import { supabaseAdmin } from '../lib/supabase.js';
import { VoiceProviderFactory } from '../services/providers/VoiceProviderFactory.js';
import { normalizePhoneE164 } from '../services/phone-normalization.js';
import { LEAD_CHANNELS } from '../types/lead-enums.js';
import { LEAD_SOURCES, isLeadSource } from '../types/lead-source.js';

// Política acordada con el usuario (docs/tasks/outbound-lead-persistence-and-rate-limit.md,
// Problema 2): 3 llamadas/hora por IP de origen, 2 llamadas/día al mismo
// número marcado. Cuenta también los intentos que fallan — un atacante no
// debe poder reintentar sin límite solo porque un intento anterior fue
// rechazado. En desarrollo se relaja para no bloquear pruebas manuales
// repetidas (mismo criterio que datagol-frontend/src/lib/rate-limit.ts).
const isDev = process.env.NODE_ENV === 'development';
const IP_RATE_LIMIT = isDev ? 100 : 3;
const IP_RATE_WINDOW_MS = 60 * 60 * 1000;
const PHONE_RATE_LIMIT = isDev ? 50 : 2;
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
    const rawAgentId = body.agentId || body.agent_id;
    const rawPhone = body.customerPhone || body.phone || body.number || body.customer?.number;
    const customerName = body.customerName || body.name || body.customer?.name || 'Cliente Prospecto';
    const customerEmail = body.customerEmail || body.email || body.customer?.email;
    const companyName = body.companyName || 'Empresa Prospecto';
    const businessSector = body.industry || body.businessSector;
    const demoObjective = body.demoObjective || 'Probar agente de voz en vivo';
    const rawSource = body.source;
    const sourceDetail = body.sourceDetail;
    const customVariables = body.customVariables || body.assistantOverrides?.variableValues || body.dynamic_variables;

    if (!rawPhone) {
      return reply.status(400).send({
        status: 'error',
        message: 'El campo número de teléfono (customerPhone) es obligatorio.',
      });
    }

    const phone = String(rawPhone).startsWith('+') ? String(rawPhone) : `+${rawPhone}`;
    const normalizedTarget = normalizePhoneE164(phone);

    // docs/tasks/zero-lead-loss-outbound-persistence.md §3.1 — un teléfono
    // que no normaliza no puede persistirse en `contacts.phone_e164`
    // (constraint de formato) ni tiene sentido marcarlo; se rechaza aquí en
    // vez de intentarlo con el crudo, a diferencia del comportamiento previo.
    if (!normalizedTarget.success || !normalizedTarget.phoneE164) {
      return reply.status(400).send({
        status: 'error',
        message: 'El número de teléfono no es válido. Verifica el formato (incluye código de país).',
      });
    }

    const phoneE164 = normalizedTarget.phoneE164;
    const sourceIp = resolveSourceIp(request);
    const leadSource = isLeadSource(String(rawSource || '')) ? String(rawSource) : LEAD_SOURCES.SITIO_WEB;

    const [{ count: phoneAttempts }, { count: ipAttempts }] = await Promise.all([
      supabaseAdmin
        .from('outbound_call_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('target_phone_raw', phoneE164)
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
      target_phone_raw: phoneE164,
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

    // docs/tasks/zero-lead-loss-outbound-persistence.md — FASE 1: STORE-FIRST.
    // Persistir contacto + lead ANTES de gastar dinero marcando, para que un
    // timeout/rechazo del proveedor de voz nunca destruya los datos que el
    // prospecto ya tecleó. Solo aplica cuando hay organizationId (sin
    // tenant no hay dónde atribuir el lead) — mismo criterio condicional que
    // ya tenía la siembra previa a esta tarea.
    let leadId: string | null = null;
    let contactId: string | null = null;

    if (organizationId) {
      const { data: seedResult, error: seedError } = await supabaseAdmin.rpc('seed_outbound_lead', {
        p_organization_id: organizationId,
        p_phone_e164: phoneE164,
        p_full_name: String(customerName),
        p_email: customerEmail ? String(customerEmail) : null,
        p_business_name: String(companyName),
        p_business_sector: businessSector ? String(businessSector) : null,
        p_inquiry_reason: String(demoObjective),
        p_source: leadSource,
        p_source_detail: sourceDetail ? String(sourceDetail) : null,
      });

      if (seedError || !seedResult) {
        // Regla de oro: si no se puede persistir, no se marca — gastar el
        // minuto de ElevenLabs por una llamada cuyo prospecto de todas
        // formas se perdería no tiene sentido.
        request.log.error({ err: seedError, organizationId, phoneE164 }, 'No se pudo sembrar el lead antes de marcar (store-first)');
        return reply.status(500).send({
          status: 'error',
          message: 'No se pudo registrar tus datos. Intenta de nuevo en unos minutos.',
        });
      }

      leadId = (seedResult as any).lead_id ?? null;
      contactId = (seedResult as any).contact_id ?? null;
    }

    // Resolver proveedor activo ('elevenlabs' o 'vapi', o el configurado en body / org / env)
    const activeProviderType =
      body.provider ||
      (orgConfig.active_voice_provider as string) ||
      process.env.DEFAULT_VOICE_PROVIDER ||
      'elevenlabs';

    const provider = VoiceProviderFactory.getProvider(activeProviderType);

    const baseCustomVariables = typeof customVariables === 'object' && customVariables !== null ? customVariables : {};
    const mergedCustomVariables =
      leadId || contactId
        ? { ...baseCustomVariables, leadId: leadId ?? undefined, contactId: contactId ?? undefined }
        : Object.keys(baseCustomVariables).length > 0
          ? baseCustomVariables
          : undefined;

    try {
      const result = await provider.triggerOutboundCall(
        {
          organizationId: organizationId || 'default',
          agentId: rawAgentId ? String(rawAgentId) : undefined,
          customerPhone: phone,
          customerName: String(customerName),
          customerEmail: customerEmail ? String(customerEmail) : undefined,
          companyName: String(companyName),
          businessSector: businessSector ? String(businessSector) : undefined,
          demoObjective: String(demoObjective),
          customVariables: mergedCustomVariables,
        },
        orgConfig
      );

      // FASE 2 (éxito) — enlazar el conversation_id real a la fila ya
      // sembrada en Fase 1, y enriquecerla vía process_call_completed (crea
      // call_logs, fusiona sin duplicar gracias a su ON CONFLICT
      // (organization_id, conversation_id) — migración 70). Todo esto es
      // best-effort: la llamada real ya se disparó y cuesta dinero de
      // cualquier forma; un fallo aquí no debe tumbar la respuesta, el lead
      // y el contacto ya existen desde antes de marcar.
      if (organizationId && leadId) {
        try {
          await supabaseAdmin.from('leads').update({ conversation_id: result.callId }).eq('id', leadId).is('conversation_id', null);

          const { error: enrichError } = await supabaseAdmin.rpc('process_call_completed', {
            p_organization_id: organizationId,
            p_conversation_id: result.callId,
            p_provider_call_id: result.callId,
            p_caller_phone_e164: phoneE164,
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
            p_source: leadSource,
            p_source_detail: sourceDetail ? String(sourceDetail) : null,
          });
          if (enrichError) {
            request.log.error({ err: enrichError, conversationId: result.callId, organizationId, leadId }, 'No se pudo enlazar call_logs al lead sembrado');
          }
        } catch (enrichErr: any) {
          request.log.error({ err: enrichErr, conversationId: result.callId, organizationId, leadId }, 'Error inesperado enlazando la llamada al lead sembrado');
        }
      }

      return reply.send({
        status: 'success',
        message: `Llamada saliente enviada a cola vía ${result.provider}`,
        data: { ...result, leadId, contactId, callStatus: 'initiated' },
      });
    } catch (err: any) {
      request.log.error({ err }, 'Error en dispatch de llamada saliente');

      // FASE 2 (fallo) — el lead ya está guardado desde Fase 1 (si había
      // organizationId): no se propaga 500 al frontend, se responde 200 con
      // el motivo, para que la persona sepa que sus datos sí quedaron
      // registrados aunque la llamada no se haya podido marcar.
      if (leadId) {
        const reason = err?.message || 'Error desconocido al disparar la llamada saliente';
        try {
          await supabaseAdmin
            .from('leads')
            .update({
              needs_followup: true,
              followup_status: 'pendiente',
              followup_notes: `Llamada saliente falló: ${reason}. Requiere contacto manual.`,
            })
            .eq('id', leadId);
        } catch (noteErr) {
          request.log.error({ err: noteErr, leadId }, 'No se pudo anotar el fallo de la llamada en el lead ya guardado');
        }

        return reply.send({
          status: 'success',
          message: 'Tus datos han sido registrados exitosamente. Nos comunicaremos contigo en breve.',
          data: { leadId, contactId, callStatus: 'call_failed_lead_saved' },
        });
      }

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
