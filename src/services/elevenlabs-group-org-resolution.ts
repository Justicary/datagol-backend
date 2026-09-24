import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolución de la organización dueña de un webhook de ElevenLabs recibido
 * por la URL de un GRUPO de credenciales (workspace compartido, camino A de
 * `routes/webhooks/elevenlabs.ts`). Solo se invoca DESPUÉS de verificar la
 * firma HMAC del grupo: `agentId` y `conversationId` vienen del cuerpo, pero
 * ya autenticado.
 *
 * Cadena de resolución, en orden:
 *
 * 1. `agent_id` → `organizations.elevenlabs_agent_id` (agente principal).
 *    Si el agente pertenece a una organización de OTRO grupo se rechaza sin
 *    probar respaldos: el agente tiene dueño conocido y no es este grupo.
 * 2. `conversation_id` → `call_logs.provider_call_id` (llamada pre-sembrada).
 *    Las salientes que dispara el backend (`POST /api/voice/outbound`)
 *    siembran `call_logs` con el conversation_id real antes de que termine la
 *    llamada, así que la organización se conoce aunque el agente sea uno
 *    secundario (p. ej. el "Agente de Citas") que no está en
 *    `elevenlabs_agent_id`. La fila la escribió este backend, no el emisor
 *    del webhook, y además debe pertenecer al grupo autenticado.
 * 3. Organización dueña del grupo, SOLO si es la única organización del
 *    grupo. En un grupo con varias organizaciones, atribuir a la dueña una
 *    llamada de un agente desconocido podría meter la transcripción del
 *    cliente de otra organización en la dueña (AGENTS.md §5): ahí se
 *    rechaza y el agente debe registrarse.
 */

export type GroupOrgResolutionVia = 'agent_id' | 'call_log_presembrado' | 'owner_grupo_unico';

export type GroupOrgRejectionReason =
    | 'agent_de_otro_grupo'
    | 'call_log_de_otro_grupo'
    | 'sin_atribucion'
    | 'error_consulta';

export interface ResolvedGroupOrganization {
    id: string;
    status: string;
}

export type GroupOrgResolution =
    | { resolved: true; organization: ResolvedGroupOrganization; via: GroupOrgResolutionVia }
    | { resolved: false; reason: GroupOrgRejectionReason; detail?: string };

export interface ResolveGroupOrganizationParams {
    groupId: string;
    ownerOrganizationId: string;
    agentId: string;
    conversationId: string | null;
}

interface OrganizationRow {
    id: string;
    status: string;
    credential_group_id: string | null;
}

const ORG_COLUMNS = 'id, status, credential_group_id';

function toResolved(row: OrganizationRow): ResolvedGroupOrganization {
    return { id: row.id, status: row.status };
}

export async function resolveGroupOrganization(
    supabase: SupabaseClient,
    params: ResolveGroupOrganizationParams
): Promise<GroupOrgResolution> {
    const { groupId, ownerOrganizationId, agentId, conversationId } = params;

    // 1. Agente principal registrado.
    const { data: byAgent, error: agentError } = await supabase
        .from('organizations')
        .select(ORG_COLUMNS)
        .eq('elevenlabs_agent_id', agentId)
        .maybeSingle<OrganizationRow>();
    if (agentError) return { resolved: false, reason: 'error_consulta', detail: agentError.message };
    if (byAgent) {
        return byAgent.credential_group_id === groupId
            ? { resolved: true, organization: toResolved(byAgent), via: 'agent_id' }
            : { resolved: false, reason: 'agent_de_otro_grupo' };
    }

    // 2. Llamada pre-sembrada por este backend.
    if (conversationId) {
        const { data: callLog, error: callLogError } = await supabase
            .from('call_logs')
            .select('organization_id')
            .eq('provider_call_id', conversationId)
            .maybeSingle<{ organization_id: string }>();
        if (callLogError) return { resolved: false, reason: 'error_consulta', detail: callLogError.message };

        if (callLog) {
            const { data: seededOrg, error: seededError } = await supabase
                .from('organizations')
                .select(ORG_COLUMNS)
                .eq('id', callLog.organization_id)
                .maybeSingle<OrganizationRow>();
            if (seededError) return { resolved: false, reason: 'error_consulta', detail: seededError.message };
            if (seededOrg && seededOrg.credential_group_id === groupId) {
                return { resolved: true, organization: toResolved(seededOrg), via: 'call_log_presembrado' };
            }
            // La conversación ya pertenece a una organización fuera de este
            // grupo: nunca se reatribuye a la dueña.
            return { resolved: false, reason: 'call_log_de_otro_grupo' };
        }
    }

    // 3. Dueña del grupo, solo si es su única organización. Se piden 2 filas
    // para distinguir "una" de "varias" sin contar todo el grupo.
    const { data: groupOrgs, error: groupError } = await supabase
        .from('organizations')
        .select(ORG_COLUMNS)
        .eq('credential_group_id', groupId)
        .limit(2)
        .returns<OrganizationRow[]>();
    if (groupError) return { resolved: false, reason: 'error_consulta', detail: groupError.message };
    if (groupOrgs && groupOrgs.length === 1 && groupOrgs[0].id === ownerOrganizationId) {
        return { resolved: true, organization: toResolved(groupOrgs[0]), via: 'owner_grupo_unico' };
    }

    return { resolved: false, reason: 'sin_atribucion' };
}
