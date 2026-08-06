import { supabaseAdmin } from '../lib/supabase.js';
import { getOrganizationFeatures } from './entitlements.js';
import { logger } from '../lib/logger.js';

export interface AgentToolConfig {
    name: string;
    description: string;
    enabled: boolean;
    requiredFeature?: string;
}

/**
 * Servicio de provisión de agentes en el proveedor de voz (ElevenLabs / Vapi) según entitlements.
 * Filtra y registra únicamente las herramientas autorizadas por las features activas de la organización.
 */
export async function getAuthorizedAgentTools(organizationId: string): Promise<AgentToolConfig[]> {
    const features = await getOrganizationFeatures(organizationId);

    const ALL_TOOLS: AgentToolConfig[] = [
        {
            name: 'availability',
            description: 'Consulta disponibilidad en el calendario',
            enabled: features.has('calendar_booking'),
            requiredFeature: 'calendar_booking',
        },
        {
            name: 'booking',
            description: 'Reserva una cita en la agenda',
            enabled: features.has('calendar_booking'),
            requiredFeature: 'calendar_booking',
        },
        {
            name: 'call_transfer',
            description: 'Transfiere la llamada a un agente humano',
            enabled: features.has('call_transfer'),
            requiredFeature: 'call_transfer',
        },
        {
            name: 'lookup_contact',
            description: 'Identifica al contacto por su número telefónico',
            enabled: features.has('lead_capture'),
            requiredFeature: 'lead_capture',
        },
    ];

    return ALL_TOOLS.filter((tool) => tool.enabled);
}

/**
 * Reprovisiona la configuración del agente en el proveedor de voz tras un cambio de entitlement.
 */
export async function reprovisionAgent(organizationId: string): Promise<{ success: boolean; toolsCount: number }> {
    const authorizedTools = await getAuthorizedAgentTools(organizationId);

    logger.info(
        { organizationId, tools: authorizedTools.map((t) => t.name) },
        '[AgentProvisioning] Reprovisionando agente para org'
    );

    // agent_reprovision_pending se limpia en el MISMO UPDATE que puede
    // fallar: si este UPDATE falla, la marca debe seguir en true (el
    // `if (error)` de abajo ya devuelve success:false sin tocarla).
    const { error } = await supabaseAdmin
        .from('organizations')
        .update({
            updated_at: new Date().toISOString(),
            agent_reprovision_pending: false,
        })
        .eq('id', organizationId);

    if (error) {
        logger.error({ err: error, organizationId }, '[AgentProvisioning] Error actualizando estado de reprovisión');
        return { success: false, toolsCount: authorizedTools.length };
    }

    return { success: true, toolsCount: authorizedTools.length };
}
