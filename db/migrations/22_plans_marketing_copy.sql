-- =============================================================================
-- DATAGOL 2026 — Migración de Base de Datos SQL
-- =============================================================================
-- `plans` solo tenía los campos numéricos (setup_fee_mxn, monthly_fee_mxn,
-- max_concurrent_calls). El resto del contenido de cada tarjeta de precios
-- (audiencia objetivo, badge, si es el plan popular, los bullets de "Entrega
-- Inicial" y "Mantenimiento Opcional", el texto del botón CTA) vivía
-- hardcodeado en datagol-frontend/src/config/landing-data.ts — la misma
-- desincronización estructural que ya tenían los precios, ahora extendida a
-- todo el contenido de /pricing.
--
-- `show_retainer`: nueva bandera por plan para que el admin pueda ocultar
-- por completo la sección "Iguala Opcional de Mantenimiento" de un plan
-- (distinto de que el precio sea NULL = "Iguala A Medida", que sigue
-- mostrando la sección con ese texto).
--
-- `setup_includes`/`retainer_includes` son `text[]` — cada elemento es un
-- bullet completo tal como se muestra en la tarjeta, no una referencia a
-- `features`/`plan_features` (esas tablas describen entitlements técnicos
-- para el backend, no la copy de marketing con el fraseo exacto de la
-- landing).
--
-- El backfill usa el contenido real que estaba en landing-data.ts al
-- momento de esta migración, para que /pricing no quede con tarjetas vacías
-- entre esta migración y el primer ajuste del admin.
-- =============================================================================

ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS target_audience text,
    ADD COLUMN IF NOT EXISTS is_popular boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS badge text,
    ADD COLUMN IF NOT EXISTS setup_includes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS retainer_includes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS cta_text text,
    ADD COLUMN IF NOT EXISTS show_retainer boolean NOT NULL DEFAULT true;

UPDATE public.plans SET
    target_audience = 'Ideal para PyMEs y Consultorios Independientes',
    is_popular = false,
    badge = NULL,
    setup_includes = ARRAY[
        'Configuración de 1 Agente Telefónico de Voz Inbound 24/7',
        'Provisionamiento de número de teléfono local dedicado',
        'Agendamiento directo en tu Apple / Google Calendar',
        'Carga y entrenamiento de Base RAG (hasta 10 docs)',
        'Envío automático de minutas y alertas por Email',
        '10 Llamadas concurrentes'
    ],
    retainer_includes = ARRAY[
        'Mantenimiento preventivo y monitoreo 24/7',
        'Ajustes a prompts y base de conocimiento',
        'Soporte técnico por ticket (<12h)',
        'Actualizaciones de parches de seguridad'
    ],
    cta_text = '📞 Comenzar con Voz Inicial',
    show_retainer = true
WHERE key = 'starter';

UPDATE public.plans SET
    target_audience = 'Solución Integral para Empresas en Crecimiento',
    is_popular = true,
    badge = '⭐ MÁS POPULAR',
    setup_includes = ARRAY[
        'Todo lo del Plan Voz Inicial +',
        'Integración Oficial de WhatsApp Cloud API',
        'Despliegue de Bot con IA',
        'Voz Nativa Realtime Engine (<400ms)',
        'Transferencia de llamada en vivo a agentes humanos',
        'Base RAG pgvector Supabase sin límite de docs',
        '+10 Llamadas concurrentes (20 totales)'
    ],
    retainer_includes = ARRAY[
        'Monitoreo multi-canal y reintento de webhooks',
        'Actualización continua de FAQs y listas de precios',
        'Soporte prioritario por WhatsApp (<4h)',
        'Reportes de conversión y calidad'
    ],
    cta_text = '🚀 Comenzar con Pro Omnicanal',
    show_retainer = true
WHERE key = 'pro';

UPDATE public.plans SET
    target_audience = 'Solución Completa para Empresas de Servicios',
    is_popular = false,
    badge = NULL,
    setup_includes = ARRAY[
        'Todo lo del Plan Pro Omnicanal +',
        'Widget Web Embebible flotante con script dinámico',
        'Captura de Dirección y Geolocalización en vivo',
        'Campañas Telefónicas Outbound (Salientes)',
        'Dashboard Analytics y Métricas de Conversión'
    ],
    retainer_includes = ARRAY[
        'Optimización continua de conversaciones',
        'Gestión de campañas salientes y seguimiento',
        'Soporte VIP 24/7 dedicado por WhatsApp',
        'Revisión quincenal con ingeniero de IA'
    ],
    cta_text = '👑 Comenzar con Elite 360°',
    show_retainer = true
WHERE key = 'elite';

UPDATE public.plans SET
    target_audience = 'Solución a Medida para Franquicias, Corporativos y Call Centers',
    is_popular = false,
    badge = '🏢 A MEDIDA',
    setup_includes = ARRAY[
        'Conmutador Inteligente con Squads Multi-Agente',
        'Integración PBX / SIP Trunk corporativo',
        'Modalidad Marca Blanca (White-Label completa)',
        'Arquitectura dedicada de ultra-baja latencia'
    ],
    retainer_includes = ARRAY[
        'SLA de Disponibilidad Personalizado Según Contrato',
        'Ingeniero de IA y Prompt Engineer dedicado',
        'Soporte 24/7 directo con equipo directivo'
    ],
    cta_text = '🏢 Contactar a un Especialista',
    show_retainer = true
WHERE key = 'enterprise';

ALTER TABLE public.plans
    ALTER COLUMN target_audience SET NOT NULL,
    ALTER COLUMN cta_text SET NOT NULL;

COMMENT ON COLUMN public.plans.show_retainer IS
    'Si es false, /pricing oculta por completo la sección "Iguala Opcional de Mantenimiento" de este plan (distinto de monthly_fee_mxn/usd NULL, que la muestra con el texto "Iguala A Medida").';
