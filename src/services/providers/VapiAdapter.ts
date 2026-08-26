import {
  IVoiceProvider,
  OutboundCallParams,
  OutboundCallResult,
  AgentConfigParams,
} from './voice-provider.interface.js';

export class VapiAdapter implements IVoiceProvider {
  private defaultApiKey: string;
  private defaultAgentId: string;
  private defaultPhoneNumberId: string;

  constructor() {
    this.defaultApiKey = process.env.VAPI_PRIVATE_KEY || '';
    this.defaultAgentId = process.env.VAPI_AGENT_ID || '';
    this.defaultPhoneNumberId = process.env.VAPI_PHONE_NUMBER_ID || '';
  }

  async triggerOutboundCall(
    params: OutboundCallParams,
    orgConfig: Record<string, unknown>
  ): Promise<OutboundCallResult> {
    const apiKey = (orgConfig.vapi_private_key as string) || this.defaultApiKey;
    const agentId = params.agentId || (orgConfig.vapi_agent_id as string) || this.defaultAgentId;
    const phoneNumberId = (orgConfig.vapi_phone_number_id as string) || this.defaultPhoneNumberId;

    if (!apiKey || !agentId) {
      throw new Error('Faltan credenciales de VAPI para esta organización.');
    }

    const payload: Record<string, unknown> = {
      assistantId: agentId,
      customer: {
        number: params.customerPhone,
        name: params.customerName,
      },
      assistantOverrides: {
        variableValues: {
          customerName: params.customerName,
          companyName: params.companyName,
          demoObjective: params.demoObjective,
          ...params.customVariables,
        },
      },
    };

    if (phoneNumberId) {
      payload.phoneNumberId = phoneNumberId;
    }

    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error((data.message as string) || 'Error al solicitar llamada saliente en VAPI.');
    }

    return {
      callId: (data.id as string) || 'vapi_' + Date.now(),
      status: 'queued',
      provider: 'vapi',
      rawResponse: data,
    };
  }

  async syncAgentConfig(
    _orgId: string,
    params: AgentConfigParams,
    orgConfig: Record<string, unknown>
  ): Promise<boolean> {
    const apiKey = (orgConfig.vapi_private_key as string) || params.apiKey || this.defaultApiKey;
    const agentId = (orgConfig.vapi_agent_id as string) || params.agentId || this.defaultAgentId;

    if (!apiKey || !agentId) return false;

    const response = await fetch(`https://api.vapi.ai/assistant/${agentId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        firstMessage: params.firstMessage,
        model: {
          provider: 'openai',
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'system', content: params.systemPrompt }],
        },
        voice: {
          provider: '11labs',
          voiceId: params.voiceId,
        },
      }),
    });

    return response.ok;
  }

  async getAgentConfig(
    agentId: string,
    apiKey?: string
  ): Promise<{ agentId: string; firstMessage: string; systemPrompt: string; voiceId: string }> {
    const keyToUse = apiKey || this.defaultApiKey;

    const response = await fetch(`https://api.vapi.ai/assistant/${agentId}`, {
      headers: {
        Authorization: `Bearer ${keyToUse}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) throw new Error('Error al consultar configuración en VAPI.');

    const data = (await response.json()) as any;
    const sysMsg = data.model?.messages?.find((m: any) => m.role === 'system');

    return {
      agentId: data.id || agentId,
      firstMessage: data.firstMessage || '',
      systemPrompt: sysMsg?.content || data.model?.systemPrompt || '',
      voiceId: data.voice?.voiceId || 'cgSgspJ2msm6clMCkdW9',
    };
  }
}
