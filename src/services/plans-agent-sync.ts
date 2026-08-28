import { supabaseAdmin } from '../lib/supabase.js';
import { getSecret } from './secret-service.js';
import { SECRET_KEYS } from '../types/secret-keys.js';
import { logger } from '../lib/logger.js';
import { ElevenLabsAdapter } from './providers/ElevenLabsAdapter.js';
import {
    generatePlansPromptBlock,
    injectPlansSectionIntoPrompt,
    type PlanDataForPrompt,
} from './plans-prompt-formatter.js';

export interface PlansPromptPreviewResult {
    plansBlock: string;
    plansCount: number;
    plans: PlanDataForPrompt[];
}

export interface PlansSyncResult {
    success: boolean;
    agentId: string;
    organizationId: string;
    updatedPromptSnippet: string;
    message?: string;
}

/**
 * Consulta los planes activos en la base de datos y genera la vista previa
 * del bloque de System Prompt fonético.
 */
export async function getPlansPromptPreview(): Promise<PlansPromptPreviewResult> {
    const { data: plansData, error } = await supabaseAdmin
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

    if (error) {
        throw new Error(`Error al consultar la tabla 'plans': ${error.message}`);
    }

    const plans: PlanDataForPrompt[] = (plansData ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        setupFeeMxn: Number(p.setup_fee_mxn),
        monthlyFeeMxn: p.monthly_fee_mxn !== null ? Number(p.monthly_fee_mxn) : null,
        isPopular: Boolean(p.is_popular),
        badge: p.badge,
        setupIncludes: p.setup_includes ?? [],
        retainerIncludes: p.retainer_includes ?? [],
        showRetainer: p.show_retainer !== false,
        targetAudience: p.target_audience,
    }));

    const plansBlock = generatePlansPromptBlock(plans);

    return {
        plansBlock,
        plansCount: plans.length,
        plans,
    };
}

/**
 * Sincroniza la sección de planes en el System Prompt del agente de voz de ElevenLabs.
 *
 * 1. Obtiene los planes activos y genera el bloque de texto fonético.
 * 2. Resuelve la organización y credenciales de ElevenLabs (ApiKey y AgentId).
 * 3. Lee el prompt actual del agente en ElevenLabs.
 * 4. Inyecta/actualiza la sección PLANES: sin tocar el resto de directivas ni la personalidad.
 * 5. Envía la actualización vía PATCH a ElevenLabs.
 */
export async function syncPlansToElevenLabsAgent(targetOrgId?: string): Promise<PlansSyncResult> {
    const { plansBlock } = await getPlansPromptPreview();
    const normalizedOrgId = typeof targetOrgId === 'string' && targetOrgId.trim().length > 0 ? targetOrgId.trim() : undefined;

    // 1. Resolver organización
    let orgQuery = supabaseAdmin.from('organizations').select('id, name, elevenlabs_agent_id');
    if (normalizedOrgId) {
        orgQuery = orgQuery.eq('id', normalizedOrgId);
    } else {
        orgQuery = orgQuery.not('elevenlabs_agent_id', 'is', null).limit(1);
    }

    const { data: orgs, error: orgError } = await orgQuery;
    if (orgError) {
        throw new Error(`Error al resolver organización para sincronizar agente: ${orgError.message}`);
    }

    const org = orgs?.[0];
    if (!org) {
        throw new Error(
            normalizedOrgId
                ? `Organización con ID '${normalizedOrgId}' no encontrada.`
                : 'No se encontró ninguna organización con elevenlabs_agent_id configurado para sincronizar.'
        );
    }

    const orgId = org.id as string;
    const dbAgentId = org.elevenlabs_agent_id as string | null;

    // 2. Resolver API Key y Agent ID (reconocer centinelas de dummy agent como 'agent_test_widget')
    const vaultApiKey = await getSecret(orgId, SECRET_KEYS.ELEVENLABS_API_KEY);
    const apiKey = vaultApiKey || process.env.ELEVENLABS_API_KEY;
    const isDummyAgent = !dbAgentId || dbAgentId === 'agent_test_widget' || dbAgentId === 'test_agent';
    const agentId = (isDummyAgent ? process.env.ELEVENLABS_AGENT_ID : dbAgentId) || process.env.ELEVENLABS_AGENT_ID;

    if (!apiKey || !agentId) {
        throw new Error(
            `Faltan credenciales de ElevenLabs para la organización '${org.name || orgId}' (se requiere API Key y Agent ID).`
        );
    }

    // 3. Obtener configuración viva del agente en ElevenLabs
    const adapter = new ElevenLabsAdapter();
    const currentAgent = await adapter.getAgentConfig(agentId, apiKey);

    // 4. Inyectar nueva sección PLANES:
    const updatedPrompt = injectPlansSectionIntoPrompt(currentAgent.systemPrompt, plansBlock);

    // 5. Actualizar agente en ElevenLabs
    const ok = await adapter.syncAgentConfig(
        orgId,
        {
            agentId,
            apiKey,
            systemPrompt: updatedPrompt,
            firstMessage: currentAgent.firstMessage,
            voiceId: currentAgent.voiceId,
        },
        { elevenlabs_api_key: apiKey, elevenlabs_agent_id: agentId }
    );

    if (!ok) {
        throw new Error(`ElevenLabs rechazó la actualización del System Prompt para el agente ${agentId}.`);
    }

    logger.info(
        { orgId, agentId, planSnippet: plansBlock },
        '[PlansAgentSync] System Prompt de ElevenLabs sincronizado exitosamente con la tabla plans'
    );

    return {
        success: true,
        agentId,
        organizationId: orgId,
        updatedPromptSnippet: plansBlock,
        message: `System Prompt del agente '${agentId}' actualizado exitosamente con los planes vigentes.`,
    };
}
