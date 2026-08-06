import {
  IVoiceProvider,
  OutboundCallParams,
  OutboundCallResult,
  AgentConfigParams,
} from './voice-provider.interface.js';

export class ElevenLabsAdapter implements IVoiceProvider {
  private defaultApiKey: string;
  private defaultAgentId: string;
  private defaultPhoneNumber: string;

  constructor() {
    this.defaultApiKey = process.env.ELEVENLABS_API_KEY || '';
    this.defaultAgentId = process.env.ELEVENLABS_AGENT_ID || '';
    this.defaultPhoneNumber = process.env.TELNYX_PHONE_NUMBER || '+522218300450';
  }

  /**
   * Dispara una llamada saliente (Outbound Call) vía ElevenLabs ConvAI API
   */
  async triggerOutboundCall(
    params: OutboundCallParams,
    orgConfig: Record<string, unknown>
  ): Promise<OutboundCallResult> {
    const apiKey = (orgConfig.elevenlabs_api_key as string) || this.defaultApiKey;
    const agentId = (orgConfig.elevenlabs_agent_id as string) || this.defaultAgentId;
    const callerNumber =
      (orgConfig.phone_number as string) ||
      (orgConfig.telnyx_phone_number as string) ||
      this.defaultPhoneNumber;

    if (!apiKey || !agentId) {
      throw new Error('Faltan credenciales de ElevenLabs (ELEVENLABS_API_KEY o ELEVENLABS_AGENT_ID).');
    }

    let targetPhoneNumberId =
      (orgConfig.elevenlabs_phone_number_id as string) ||
      (orgConfig.phone_number_id as string) ||
      process.env.ELEVENLABS_PHONE_NUMBER_ID;

    // Si no se proporcionó phone_number_id explícito, resolverlo dinámicamente desde la API de ElevenLabs
    if (!targetPhoneNumberId) {
      try {
        const phoneListRes = await fetch('https://api.elevenlabs.io/v1/convai/phone-numbers', {
          headers: { 'xi-api-key': apiKey },
        });
        if (phoneListRes.ok) {
          const phoneList = (await phoneListRes.json()) as any[];
          if (Array.isArray(phoneList) && phoneList.length > 0) {
            const matched = phoneList.find((p) => p.phone_number === callerNumber) || phoneList[0];
            targetPhoneNumberId = matched?.phone_number_id;
          }
        }
      } catch (err: any) {
        console.warn('⚠️ Advertencia: No se pudo resolver automáticamente el phone_number_id de ElevenLabs:', err.message);
      }
    }

    const disclaimerGreeting = `Hola ${params.customerName}, le saluda Sofía de ${params.companyName}, un asistente virtual con Inteligencia Artificial. ${params.demoObjective}`;

    // Estructura oficial según la documentación de ElevenLabs Agents Skill
    const payload: Record<string, unknown> = {
      agent_id: agentId,
      agent_phone_number_id: targetPhoneNumberId,
      phone_number_id: targetPhoneNumberId,
      to_number: params.customerPhone,
      recipient_phone_number: params.customerPhone,
      conversation_initiation_client_data: {
        dynamic_variables: {
          customer_name: params.customerName,
          company_name: params.companyName,
          demo_objective: params.demoObjective,
          custom_greeting: disclaimerGreeting,
          caller_phone: callerNumber,
          ...params.customVariables,
        },
      },
    };

    console.log(`📡 Disparando llamada SIP Trunk vía ElevenLabs ConvAI a ${params.customerPhone}...`);

    let response = await fetch('https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok && (response.status === 404 || response.status === 405)) {
      console.log('🔄 Reintentando con endpoint alternativo /convai/phone-numbers/call...');
      response = await fetch('https://api.elevenlabs.io/v1/convai/phone-numbers/call', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    if (!response.ok && response.status === 404) {
      response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      console.error('❌ Error devuelto por ElevenLabs ConvAI API:', data);
      const detailObj = data.detail as any;
      const errorMsg =
        typeof detailObj === 'object' && detailObj?.message
          ? detailObj.message
          : (data.detail as string) || (data.message as string) || 'Error al iniciar la llamada en ElevenLabs.';
      throw new Error(errorMsg);
    }

    return {
      callId: (data.conversation_id as string) || (data.call_id as string) || 'el_' + Date.now(),
      status: 'queued',
      provider: 'elevenlabs',
      rawResponse: data,
    };
  }

  /**
   * Obtiene la Signed URL para conexión Inbound WebRTC / WebSocket conversacional en tiempo real
   */
  async getSignedUrl(agentId?: string, apiKey?: string): Promise<{ signedUrl: string }> {
    const keyToUse = apiKey || this.defaultApiKey;
    const targetAgentId = agentId || this.defaultAgentId;

    if (!keyToUse || !targetAgentId) {
      throw new Error('Se requiere API Key y Agent ID de ElevenLabs para generar la Signed URL.');
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${targetAgentId}`,
      {
        headers: {
          'xi-api-key': keyToUse,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = (await response.json()) as any;

    if (!response.ok) {
      const detailObj = data.detail as any;
      const errorMsg =
        typeof detailObj === 'object' && detailObj?.message
          ? detailObj.message
          : (data.detail as string) || 'Error al obtener Signed URL de ElevenLabs.';
      throw new Error(errorMsg);
    }

    return { signedUrl: data.signed_url };
  }

  /**
   * Sincroniza la configuración del Agente en ElevenLabs ConvAI
   */
  async syncAgentConfig(
    _orgId: string,
    params: AgentConfigParams,
    orgConfig: Record<string, unknown>
  ): Promise<boolean> {
    const apiKey = (orgConfig.elevenlabs_api_key as string) || params.apiKey || this.defaultApiKey;
    const agentId = (orgConfig.elevenlabs_agent_id as string) || params.agentId || this.defaultAgentId;

    if (!apiKey || !agentId) {
      throw new Error('No se puede sincronizar el agente sin API Key ni Agent ID de ElevenLabs.');
    }

    const payload = {
      conversation_config: {
        agent: {
          first_message: params.firstMessage,
          prompt: {
            prompt: params.systemPrompt,
          },
        },
        tts: {
          voice_id: params.voiceId || 'cgSgspJ2msm6clMCkdW9', // Paulina Latina por defecto
        },
      },
    };

    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      method: 'PATCH',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as Record<string, unknown>;
      console.error('❌ Error al actualizar Agente en ElevenLabs:', errorData);
      return false;
    }

    return true;
  }

  /**
   * Obtiene la configuración viva del Agente en ElevenLabs ConvAI
   */
  async getAgentConfig(
    agentId: string,
    apiKey?: string
  ): Promise<{ agentId: string; firstMessage: string; systemPrompt: string; voiceId: string }> {
    const keyToUse = apiKey || this.defaultApiKey;

    const response = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: {
        'xi-api-key': keyToUse,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Error al consultar la configuración en ElevenLabs ConvAI.');
    }

    const agentData = (await response.json()) as any;

    return {
      agentId: agentData.agent_id || agentId,
      firstMessage: agentData.conversation_config?.agent?.first_message || '',
      systemPrompt: agentData.conversation_config?.agent?.prompt?.prompt || '',
      voiceId: agentData.conversation_config?.tts?.voice_id || 'cgSgspJ2msm6clMCkdW9',
    };
  }
}
