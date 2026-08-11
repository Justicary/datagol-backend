-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- docs/tasks/opus.md — Métricas por canal para GET /api/organizations/:id/metrics.
--
-- Se implementa como FUNCIÓN, no VISTA: la vista no puede recibir
-- organization_id/rango de fechas como parámetro sin recurrir a una vista
-- paramétrica (SRF) que en la práctica se escribe igual que una función —
-- y todo el resto de agregación cross-tabla de este proyecto
-- (process_call_completed, erase_contact_pii, organization_enabled_features)
-- ya sigue el patrón `CREATE FUNCTION ... RETURNS jsonb`. Se mantiene la
-- simetría en vez de introducir un segundo estilo.
--
-- ATRIBUCIÓN DE COSTO (instrucción explícita de la tarea): se une
-- usage_events con leads por conversation_id, NUNCA se infiere el canal del
-- unit_type — los tokens de LLM (y agent_minute) se consumen igual en voz y
-- en WhatsApp, así que unit_type no distingue canal.
--
-- CONSUMO HUÉRFANO (usage_events sin lead que empate por conversation_id):
-- documentado explícitamente, nunca descartado en silencio. Puede ser
-- legítimo — un asiento compensatorio manual (migración 15, idempotency_key
-- NULL a propósito) no necesariamente corresponde a una conversación
-- completa — o puede ser un fallo real de negocio (el job de
-- process_call_completed falló después de registrar el consumo pero antes
-- de insertar el lead). En ambos casos se expone como `unattributedUsage` a
-- nivel de organización, con su propio total en USD/MXN y desglose por
-- categoría, para que quien concilie contra la factura del proveedor vea la
-- diferencia entre "costo por canal" y "costo total real" y sepa que existe
-- consumo sin canal atribuible en vez de que el total simplemente no cuadre
-- sin explicación.
--
-- CONVERSIÓN A MXN: no existe ninguna tarifa de metering en MXN en el
-- esquema (provider_rates es 100% USD, ver migración 15). Se reutiliza
-- `organizations.integration_settings.tipoCambioUSD` — el mismo campo que ya
-- usa GET /api/plans/public para mostrar el precio de los planes en USD a
-- partir de su precio MXN real (routes/plans.ts, routes/admin/plans.ts) — en
-- vez de introducir una tabla de tipo de cambio nueva o un literal en
-- código. Es una tasa "de exhibición" vigente al momento de la consulta, no
-- una tarifa histórica por evento como unit_rate_usd: aplicarla
-- retroactivamente a costos de periodos pasados es una aproximación
-- deliberada y documentada, no un descuido — el equivalente de mostrar hoy
-- "esto costó $X USD, que al tipo de cambio actual son $Y MXN". Si la
-- organización no tiene tipoCambioUSD configurado, todo campo *Mxn sale
-- NULL (nunca se inventa una tasa, mismo principio que rate-service.ts con
-- unit_rate_usd).
--
-- CATEGORÍA DE unit_type: se colapsan los unit_type dinámicos de LLM
-- (llm_input_token_<modelo>/llm_output_token_<modelo>) bajo una sola
-- categoría 'llm_tokens' — instrucción explícita de la tarea, exponer una
-- fila por modelo no le sirve al cliente. Se extrae a una función propia
-- (`usage_event_cost_category`) para no duplicar el CASE en dos lugares de
-- esta migración (desglose por canal y desglose de huérfanos).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.usage_event_cost_category(p_unit_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_unit_type = 'agent_minute' THEN 'agent_minute'
        WHEN p_unit_type = 'wa_message' THEN 'wa_message'
        WHEN p_unit_type LIKE 'sip\_%' ESCAPE '\' THEN 'telephony'
        WHEN p_unit_type LIKE 'llm\_input\_token\_%' ESCAPE '\' OR p_unit_type LIKE 'llm\_output\_token\_%' ESCAPE '\' THEN 'llm_tokens'
        ELSE 'other'
    END;
$$;

COMMENT ON FUNCTION public.usage_event_cost_category(text) IS
    'Colapsa usage_events.unit_type a una categoría estable para exponer al cliente: agent_minute, wa_message, telephony (sip_*), llm_tokens (llm_input_token_<modelo>/llm_output_token_<modelo>, un modelo nuevo no requiere cambiar esta función), other (cualquier unit_type futuro no contemplado, nunca se pierde silenciosamente). Ver docs/tasks/opus.md.';

CREATE OR REPLACE FUNCTION public.get_organization_channel_metrics(
    p_organization_id uuid,
    p_from timestamptz,
    p_to timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_tipo_cambio numeric;
    v_channels jsonb;
    v_unattributed jsonb;
    v_cross_channel_contacts integer;
BEGIN
    SELECT (integration_settings ->> 'tipoCambioUSD')::numeric INTO v_tipo_cambio
    FROM public.organizations
    WHERE id = p_organization_id;

    -- El periodo se ancla en leads.created_at (una fila = una conversación).
    -- Todo usage_events que empate por conversation_id con un lead del
    -- periodo se atribuye completo a ese canal, sin volver a filtrar por
    -- usage_events.occurred_at: son la misma conversación, y filtrar dos
    -- veces podría partir el costo de una sola llamada entre dos periodos
    -- si occurred_at se registró unos segundos después de created_at.
    WITH leads_in_period AS (
        SELECT id, COALESCE(channel, 'unknown') AS channel, conversation_id,
               full_name, email, contact_phone, temperature, booked_appointment
        FROM public.leads
        WHERE organization_id = p_organization_id
          AND created_at >= p_from
          AND created_at < p_to
    ),
    usage_costed AS (
        SELECT
            ue.conversation_id,
            public.usage_event_cost_category(ue.unit_type) AS category,
            COALESCE(ue.amount_usd, ue.quantity * ue.unit_rate_usd) AS cost_usd
        FROM public.usage_events ue
        WHERE ue.organization_id = p_organization_id
    ),
    lead_usage AS (
        SELECT l.channel, l.id AS lead_id, uc.category, uc.cost_usd
        FROM leads_in_period l
        LEFT JOIN usage_costed uc ON uc.conversation_id = l.conversation_id
    ),
    channel_leads AS (
        SELECT
            channel,
            count(*) AS conversations_total,
            count(*) FILTER (WHERE full_name IS NOT NULL OR email IS NOT NULL OR contact_phone IS NOT NULL) AS leads_captured,
            count(*) FILTER (WHERE temperature = 'caliente') AS hot_leads,
            count(*) FILTER (WHERE booked_appointment) AS appointments_booked
        FROM leads_in_period
        GROUP BY channel
    ),
    channel_totals AS (
        SELECT channel, SUM(cost_usd) AS cost_usd
        FROM lead_usage
        GROUP BY channel
    ),
    channel_categories AS (
        SELECT channel, category, SUM(cost_usd) AS cost_usd
        FROM lead_usage
        WHERE category IS NOT NULL
        GROUP BY channel, category
    )
    SELECT jsonb_agg(
        jsonb_build_object(
            'channel', cl.channel,
            'conversationsTotal', cl.conversations_total,
            'leadsCaptured', cl.leads_captured,
            'hotLeads', cl.hot_leads,
            'appointmentsBooked', cl.appointments_booked,
            'costUsd', round(COALESCE(ct.cost_usd, 0), 6),
            'costMxn', CASE WHEN v_tipo_cambio IS NOT NULL THEN round(COALESCE(ct.cost_usd, 0) * v_tipo_cambio, 4) ELSE NULL END,
            'costByCategory', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'category', cc.category,
                        'costUsd', round(cc.cost_usd, 6),
                        'costMxn', CASE WHEN v_tipo_cambio IS NOT NULL THEN round(cc.cost_usd * v_tipo_cambio, 4) ELSE NULL END
                    ) ORDER BY cc.category
                )
                FROM channel_categories cc
                WHERE cc.channel = cl.channel
            ), '[]'::jsonb),
            -- Costo por prospecto capturado / por cita agendada (métricas
            -- derivadas, sección 2 de la tarea): NULL cuando el denominador es
            -- 0 — un costo-por-cero no es un costo de cero, es indefinido, y
            -- reportar 0 confundiría "gratis" con "no aplica".
            'costPerLeadCapturedUsd', CASE WHEN cl.leads_captured > 0 THEN round(COALESCE(ct.cost_usd, 0) / cl.leads_captured, 6) ELSE NULL END,
            'costPerAppointmentUsd', CASE WHEN cl.appointments_booked > 0 THEN round(COALESCE(ct.cost_usd, 0) / cl.appointments_booked, 6) ELSE NULL END,
            -- Tasa de conversión a cita: citas agendadas sobre conversaciones
            -- totales del canal (embudo completo, no solo sobre prospectos ya
            -- capturados) — 0 si no hubo conversaciones, nunca NULL, porque
            -- "cero conversiones sobre cero conversaciones" sí es un dato
            -- válido para un canal sin actividad en el periodo.
            'appointmentConversionRate', CASE WHEN cl.conversations_total > 0 THEN round(cl.appointments_booked::numeric / cl.conversations_total, 4) ELSE 0 END
        ) ORDER BY cl.channel
    ) INTO v_channels
    FROM channel_leads cl
    LEFT JOIN channel_totals ct ON ct.channel = cl.channel;

    -- Consumo huérfano: usage_events del periodo (por occurred_at, aquí sí,
    -- porque no hay lead que ancle el periodo) sin ningún lead de esta
    -- organización que empate por conversation_id. Nunca se descarta: se
    -- reporta aparte, con su propio desglose por categoría, para que la
    -- conciliación contra la factura del proveedor explique la diferencia
    -- entre "costo por canal" y "costo total" en vez de que simplemente no
    -- cuadre.
    -- Nota de implementación: `costByCategory` se resuelve en dos pasos
    -- (CTE `orphaned_categories` ya agregado por SUM, luego jsonb_agg sobre
    -- esas filas) en vez de un SUM() dentro de un jsonb_agg() en la misma
    -- consulta — Postgres rechaza anidar dos llamadas a función de
    -- agregación en el mismo nivel (error 42803), mismo motivo por el que
    -- el bloque de canales ya usaba `channel_categories` como CTE separado.
    WITH orphaned AS (
        SELECT
            public.usage_event_cost_category(ue.unit_type) AS category,
            COALESCE(ue.amount_usd, ue.quantity * ue.unit_rate_usd) AS cost_usd
        FROM public.usage_events ue
        WHERE ue.organization_id = p_organization_id
          AND ue.occurred_at >= p_from
          AND ue.occurred_at < p_to
          AND NOT EXISTS (
              SELECT 1 FROM public.leads l
              WHERE l.organization_id = ue.organization_id
                AND l.conversation_id = ue.conversation_id
          )
    ),
    orphaned_categories AS (
        SELECT category, SUM(cost_usd) AS cost_usd
        FROM orphaned
        GROUP BY category
    )
    SELECT jsonb_build_object(
        'entriesCount', (SELECT count(*) FROM orphaned),
        'costUsd', round(COALESCE((SELECT SUM(cost_usd) FROM orphaned), 0), 6),
        'costMxn', CASE WHEN v_tipo_cambio IS NOT NULL THEN round(COALESCE((SELECT SUM(cost_usd) FROM orphaned), 0) * v_tipo_cambio, 4) ELSE NULL END,
        'costByCategory', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'category', oc.category,
                    'costUsd', round(oc.cost_usd, 6),
                    'costMxn', CASE WHEN v_tipo_cambio IS NOT NULL THEN round(oc.cost_usd * v_tipo_cambio, 4) ELSE NULL END
                ) ORDER BY oc.category
            )
            FROM orphaned_categories oc
        ), '[]'::jsonb)
    ) INTO v_unattributed;

    -- Contactos cross-canal: histórico completo (no acotado al periodo) a
    -- propósito — que un contacto haya usado dos canales es un hecho sobre
    -- el contacto, no sobre el periodo consultado; acotarlo por periodo haría
    -- que el mismo contacto "dejara" de ser cross-canal solo por elegir un
    -- rango de fechas corto.
    SELECT count(*) INTO v_cross_channel_contacts
    FROM (
        SELECT contact_id
        FROM public.leads
        WHERE organization_id = p_organization_id AND contact_id IS NOT NULL
        GROUP BY contact_id
        HAVING count(DISTINCT channel) > 1
    ) x;

    RETURN jsonb_build_object(
        'organizationId', p_organization_id,
        'periodFrom', p_from,
        'periodTo', p_to,
        'channels', COALESCE(v_channels, '[]'::jsonb),
        'unattributedUsage', v_unattributed,
        'crossChannelContacts', v_cross_channel_contacts,
        'exchangeRateUsed', v_tipo_cambio
    );
END;
$$;

COMMENT ON FUNCTION public.get_organization_channel_metrics(uuid, timestamptz, timestamptz) IS
    'Métricas por canal (leads.channel) de una organización en un periodo: conversaciones, prospectos capturados/calientes, citas agendadas, costo USD/MXN (total y por categoría) y métricas derivadas (costo por prospecto/cita, tasa de conversión). El costo se atribuye uniendo usage_events con leads por conversation_id, nunca infiriendo canal del unit_type. Expone unattributedUsage para el consumo que no empata con ningún lead, y crossChannelContacts (histórico, no acotado al periodo). Backing de GET /api/organizations/:id/metrics. Ver docs/tasks/opus.md.';
