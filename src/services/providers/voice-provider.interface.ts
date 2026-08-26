export interface OutboundCallParams {
  organizationId: string;
  agentId?: string;
  customerPhone: string;
  customerName: string;
  customerEmail?: string;
  companyName: string;
  businessSector?: string;
  demoObjective: string;
  customVariables?: Record<string, unknown>;
}

export interface OutboundCallResult {
  callId: string;
  status: 'queued' | 'initiated' | 'failed';
  provider: string;
  rawResponse?: Record<string, unknown>;
}

export interface AgentConfigParams {
  firstMessage: string;
  systemPrompt: string;
  voiceId: string;
  agentId?: string;
  apiKey?: string;
}

export interface IVoiceProvider {
  /**
   * Dispara una llamada saliente (Outbound Call)
   */
  triggerOutboundCall(
    params: OutboundCallParams,
    orgConfig: Record<string, unknown>
  ): Promise<OutboundCallResult>;

  /**
   * Sincroniza la configuración del agente (Saludo, Prompt y Voz) en el proveedor
   */
  syncAgentConfig(
    orgId: string,
    params: AgentConfigParams,
    orgConfig: Record<string, unknown>
  ): Promise<boolean>;

  /**
   * Obtiene la configuración viva del agente desde el proveedor
   */
  getAgentConfig(
    agentId: string,
    apiKey?: string
  ): Promise<{
    agentId: string;
    firstMessage: string;
    systemPrompt: string;
    voiceId: string;
  }>;
}
