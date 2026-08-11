import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuthenticatedUser, requireOrganizationMembership, requireOrganizationRole } from '../lib/organization-auth.js';
import { CONTACT_LIFECYCLE_STAGES, CONTACT_PIPELINE_STAGES, isLifecyclePipelineCoherent } from '../types/contact-enums.js';
import {
    orgContactParamsSchema,
    orgContactAddressParamsSchema,
    orgAppointmentParamsSchema,
    orgIdParamsSchema,
    contactUpdateBodySchema,
    contactPipelineUpdateBodySchema,
    contactNoteBodySchema,
    contactAddressBodySchema,
    contactAddressUpdateBodySchema,
    appointmentStatusUpdateBodySchema,
    contactMergeBodySchema,
} from '../schemas/contacts-crm.js';

const OPTED_OUT_MESSAGE = 'Este contacto se dio de baja (opted_out) — no se pueden realizar acciones sobre él.';

/**
 * Endpoints de escritura del CRM de contactos (Fase D, docs/tasks/opus.md).
 * Mismo patrón de auth que routes/contacts.ts: requireAuthenticatedUser +
 * requireOrganizationMembership, `fastify.supabaseUser(jwt)` para las
 * operaciones (respeta RLS) salvo donde se documenta lo contrario.
 */
export async function contactsCrmRoutes(fastify: FastifyInstance) {
    /**
     * Helper interno: autentica, verifica pertenencia, valida que el
     * contactId de la URL pertenezca a la organización, y bloquea si el
     * contacto está opted_out (Fase E: "opted_out bloquea toda acción de
     * contacto, verificado en servidor"). Devuelve `null` y ya respondió el
     * error en ese caso.
     */
    async function authorizeContactWrite(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<{ userId: string; jwt: string; organizationId: string; contactId: string } | null> {
        const paramsResult = orgContactParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id" y "contactId" deben ser UUID válidos.' });
            return null;
        }
        const { id: organizationId, contactId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return null;

        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
            return null;
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data: contact, error } = await scopedClient
            .from('contacts')
            .select('id, organization_id, opted_out')
            .eq('id', contactId)
            .maybeSingle();

        if (error || !contact || contact.organization_id !== organizationId) {
            reply.status(404).send({ success: false, error: 'Contacto no encontrado en esta organización.' });
            return null;
        }

        if (contact.opted_out) {
            reply.status(403).send({ success: false, error: OPTED_OUT_MESSAGE });
            return null;
        }

        return { userId: auth.userId, jwt: auth.jwt, organizationId, contactId };
    }

    /**
     * PATCH /api/organizations/:id/contacts/:contactId
     * Perfil general del contacto. NO toca lifecycle_stage/pipeline_stage —
     * eso vive en el endpoint dedicado de abajo (cambio de etapa es una
     * acción de negocio distinta, con sus propias reglas de coherencia).
     */
    fastify.patch('/api/organizations/:id/contacts/:contactId', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const bodyResult = contactUpdateBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido.' });
        }

        const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (bodyResult.data.fullName !== undefined) updatePayload.full_name = bodyResult.data.fullName;
        if (bodyResult.data.email !== undefined) updatePayload.email = bodyResult.data.email;
        if (bodyResult.data.businessName !== undefined) updatePayload.business_name = bodyResult.data.businessName;
        if (bodyResult.data.businessSector !== undefined) updatePayload.business_sector = bodyResult.data.businessSector;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient.from('contacts').update(updatePayload).eq('id', ctx.contactId).select().single();

        if (error || !data) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, err: error?.message, msg: 'Error actualizando contacto' });
            return reply.status(500).send({ success: false, error: 'No se pudo actualizar el contacto.' });
        }

        return reply.send({ success: true, data });
    });

    /**
     * PATCH /api/organizations/:id/contacts/:contactId/pipeline
     * Cambio de etapa. ganado exige wonAt (o se fija a "ahora" si no se
     * manda); perdido exige lostReason. lifecycle_stage se deriva
     * SIEMPRE del lado del servidor (nunca la manda el cliente): es la
     * única forma de garantizar coherencia con contacts_lifecycle_pipeline_coherent
     * sin exponerle al llamador el detalle de esa regla.
     */
    fastify.patch('/api/organizations/:id/contacts/:contactId/pipeline', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const bodyResult = contactPipelineUpdateBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "pipelineStage" válido.' });
        }
        const { pipelineStage, wonAt, lostReason } = bodyResult.data;

        let lifecycleStage: string;
        const updatePayload: Record<string, unknown> = {
            pipeline_stage: pipelineStage,
            pipeline_updated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        if (pipelineStage === CONTACT_PIPELINE_STAGES.GANADO) {
            lifecycleStage = CONTACT_LIFECYCLE_STAGES.CLIENTE;
            updatePayload.won_at = wonAt ?? new Date().toISOString();
            updatePayload.lost_reason = null;
        } else if (pipelineStage === CONTACT_PIPELINE_STAGES.PERDIDO) {
            if (!lostReason) {
                return reply.status(400).send({ success: false, error: 'Se requiere "lostReason" para marcar la etapa como "perdido".' });
            }
            lifecycleStage = CONTACT_LIFECYCLE_STAGES.DESCARTADO;
            updatePayload.lost_reason = lostReason;
            updatePayload.won_at = null;
        } else {
            // Reabrir/avanzar en el embudo: siempre "prospecto" — es el único
            // lifecycle_stage coherente con cualquier pipeline_stage que no
            // sea ganado (contacts_lifecycle_pipeline_coherent).
            lifecycleStage = CONTACT_LIFECYCLE_STAGES.PROSPECTO;
            updatePayload.won_at = null;
            updatePayload.lost_reason = null;
        }
        updatePayload.lifecycle_stage = lifecycleStage;

        if (!isLifecyclePipelineCoherent(lifecycleStage, pipelineStage)) {
            // No debería ocurrir dado el mapeo de arriba — red de seguridad
            // para no mandar un UPDATE que sabemos que la base rechazaría.
            return reply.status(400).send({ success: false, error: 'Combinación de lifecycle_stage/pipeline_stage no coherente.' });
        }

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient.from('contacts').update(updatePayload).eq('id', ctx.contactId).select().single();

        if (error || !data) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, err: error?.message, msg: 'Error actualizando pipeline del contacto' });
            return reply.status(500).send({ success: false, error: 'No se pudo actualizar la etapa del contacto.' });
        }

        return reply.send({ success: true, data });
    });

    /**
     * POST /api/organizations/:id/contacts/:contactId/notes
     */
    fastify.post('/api/organizations/:id/contacts/:contactId/notes', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const bodyResult = contactNoteBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "body".' });
        }

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient
            .from('contact_notes')
            .insert({ organization_id: ctx.organizationId, contact_id: ctx.contactId, body: bodyResult.data.body, author_user_id: ctx.userId })
            .select()
            .single();

        if (error || !data) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, err: error?.message, msg: 'Error creando nota de contacto' });
            return reply.status(500).send({ success: false, error: 'No se pudo guardar la nota.' });
        }

        return reply.status(201).send({ success: true, data });
    });

    /**
     * GET /api/organizations/:id/contacts/:contactId/addresses
     */
    fastify.get('/api/organizations/:id/contacts/:contactId/addresses', async (request, reply) => {
        const paramsResult = orgContactParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id" y "contactId" deben ser UUID válidos.' });
        }
        const { id: organizationId, contactId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;
        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data, error } = await scopedClient
            .from('contact_addresses')
            .select('*')
            .eq('organization_id', organizationId)
            .eq('contact_id', contactId)
            .is('archived_at', null)
            .order('is_primary', { ascending: false })
            .order('created_at', { ascending: false });

        if (error) {
            request.log.error({ organizationId, contactId, err: error.message, msg: 'Error listando direcciones del contacto' });
            return reply.status(500).send({ success: false, error: 'No se pudieron listar las direcciones.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });

    /**
     * POST /api/organizations/:id/contacts/:contactId/addresses
     * Usa resolve_contact_address (dedup por dedupe_key, misma primitiva de
     * Fase B/C) en vez de un INSERT directo — evitar direcciones duplicadas
     * es el motivo de que esa función exista.
     */
    fastify.post('/api/organizations/:id/contacts/:contactId/addresses', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const bodyResult = contactAddressBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: se requiere "street".' });
        }
        const body = bodyResult.data;

        const { data: addressId, error: rpcError } = await fastify.supabaseAdmin.rpc('resolve_contact_address', {
            p_org_id: ctx.organizationId,
            p_contact_id: ctx.contactId,
            p_street: body.street,
            p_city: body.city ?? null,
            p_state: body.state ?? null,
            p_postal_code: body.postalCode ?? null,
            p_lat: body.latitude ?? null,
            p_lng: body.longitude ?? null,
            p_type: body.addressType ?? undefined,
        });

        if (rpcError || !addressId) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, err: rpcError?.message, msg: 'Error consolidando dirección de contacto' });
            return reply.status(500).send({ success: false, error: 'No se pudo guardar la dirección.' });
        }

        // resolve_contact_address no acepta `label` — se completa aparte si
        // el llamador lo mandó (best-effort, no bloquea la creación).
        if (body.label) {
            await fastify.supabaseAdmin.from('contact_addresses').update({ label: body.label }).eq('id', addressId);
        }

        const { data: address } = await fastify.supabaseAdmin.from('contact_addresses').select('*').eq('id', addressId).single();

        return reply.status(201).send({ success: true, data: address });
    });

    /**
     * PATCH /api/organizations/:id/contacts/:contactId/addresses/:addressId
     * Incluye marcar principal (isPrimary): la base no tiene una función
     * dedicada para esto, así que se hace en dos pasos (desmarcar la
     * principal anterior, marcar la nueva) — aceptable para una acción de
     * baja concurrencia iniciada por un humano desde el dashboard, no un
     * camino crítico de voz.
     */
    fastify.patch('/api/organizations/:id/contacts/:contactId/addresses/:addressId', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const addressParamsResult = orgContactAddressParamsSchema.safeParse(request.params);
        if (!addressParamsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "addressId" debe ser un UUID válido.' });
        }
        const { addressId } = addressParamsResult.data;

        const bodyResult = contactAddressUpdateBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido.' });
        }
        const body = bodyResult.data;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data: existing, error: fetchError } = await scopedClient
            .from('contact_addresses')
            .select('id, is_primary')
            .eq('id', addressId)
            .eq('organization_id', ctx.organizationId)
            .eq('contact_id', ctx.contactId)
            .is('archived_at', null)
            .maybeSingle();

        if (fetchError || !existing) {
            return reply.status(404).send({ success: false, error: 'Dirección no encontrada para este contacto.' });
        }

        if (body.isPrimary === true && !existing.is_primary) {
            const { error: demoteError } = await scopedClient
                .from('contact_addresses')
                .update({ is_primary: false })
                .eq('contact_id', ctx.contactId)
                .eq('is_primary', true);
            if (demoteError) {
                request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, err: demoteError.message, msg: 'Error desmarcando dirección principal anterior' });
                return reply.status(500).send({ success: false, error: 'No se pudo actualizar la dirección principal.' });
            }
        }

        const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.street !== undefined) updatePayload.street = body.street;
        if (body.label !== undefined) updatePayload.label = body.label;
        if (body.addressType !== undefined) updatePayload.address_type = body.addressType;
        if (body.city !== undefined) updatePayload.city = body.city;
        if (body.state !== undefined) updatePayload.state = body.state;
        if (body.postalCode !== undefined) updatePayload.postal_code = body.postalCode;
        if (body.latitude !== undefined) updatePayload.latitude = body.latitude;
        if (body.longitude !== undefined) updatePayload.longitude = body.longitude;
        if (body.isPrimary !== undefined) updatePayload.is_primary = body.isPrimary;

        const { data, error } = await scopedClient.from('contact_addresses').update(updatePayload).eq('id', addressId).select().single();
        if (error || !data) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, addressId, err: error?.message, msg: 'Error actualizando dirección' });
            return reply.status(500).send({ success: false, error: 'No se pudo actualizar la dirección.' });
        }

        return reply.send({ success: true, data });
    });

    /**
     * DELETE /api/organizations/:id/contacts/:contactId/addresses/:addressId
     * Archiva, no borra (mismo criterio que el resto del sistema:
     * appointments/contact_notes referencian la fila, borrarla de verdad
     * rompería ese historial).
     */
    fastify.delete('/api/organizations/:id/contacts/:contactId/addresses/:addressId', async (request, reply) => {
        const ctx = await authorizeContactWrite(request, reply);
        if (!ctx) return;

        const addressParamsResult = orgContactAddressParamsSchema.safeParse(request.params);
        if (!addressParamsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "addressId" debe ser un UUID válido.' });
        }
        const { addressId } = addressParamsResult.data;

        const scopedClient = fastify.supabaseUser(ctx.jwt);
        const { data, error } = await scopedClient
            .from('contact_addresses')
            .update({ archived_at: new Date().toISOString(), is_primary: false })
            .eq('id', addressId)
            .eq('organization_id', ctx.organizationId)
            .eq('contact_id', ctx.contactId)
            .is('archived_at', null)
            .select('id')
            .maybeSingle();

        if (error) {
            request.log.error({ organizationId: ctx.organizationId, contactId: ctx.contactId, addressId, err: error.message, msg: 'Error archivando dirección' });
            return reply.status(500).send({ success: false, error: 'No se pudo archivar la dirección.' });
        }
        if (!data) {
            return reply.status(404).send({ success: false, error: 'Dirección no encontrada para este contacto.' });
        }

        return reply.send({ success: true, data: { addressId } });
    });

    /**
     * PATCH /api/organizations/:id/appointments/:appointmentId/status
     * No aplica el bloqueo de opted_out (Fase E lo define para "acciones de
     * contacto"; cancelar/confirmar una cita ya agendada es una acción sobre
     * la cita, no un nuevo contacto con alguien que se dio de baja).
     */
    fastify.patch('/api/organizations/:id/appointments/:appointmentId/status', async (request, reply) => {
        const paramsResult = orgAppointmentParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id" y "appointmentId" deben ser UUID válidos.' });
        }
        const { id: organizationId, appointmentId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;
        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const bodyResult = appointmentStatusUpdateBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: 'Cuerpo de la petición inválido: "status" debe ser confirmed, cancelled o rescheduled.' });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data, error } = await scopedClient
            .from('appointments')
            .update({ status: bodyResult.data.status })
            .eq('id', appointmentId)
            .eq('organization_id', organizationId)
            .select()
            .maybeSingle();

        if (error) {
            request.log.error({ organizationId, appointmentId, err: error.message, msg: 'Error actualizando estado de cita' });
            return reply.status(500).send({ success: false, error: 'No se pudo actualizar el estado de la cita.' });
        }
        if (!data) {
            return reply.status(404).send({ success: false, error: 'Cita no encontrada en esta organización.' });
        }

        return reply.send({ success: true, data });
    });

    /**
     * GET /api/organizations/:id/contacts/duplicates
     * Envuelve v_duplicate_contact_candidates (pares de contactos que
     * comparten correo, ya resuelta por la base).
     */
    fastify.get('/api/organizations/:id/contacts/duplicates', async (request, reply) => {
        const paramsResult = orgIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;
        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data, error } = await scopedClient.from('v_duplicate_contact_candidates').select('*').eq('organization_id', organizationId);

        if (error) {
            request.log.error({ organizationId, err: error.message, msg: 'Error consultando candidatos a duplicado' });
            return reply.status(500).send({ success: false, error: 'No se pudieron consultar los duplicados.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });

    /**
     * POST /api/organizations/:id/contacts/merge
     * Fase E: solo admin/owner. `merge_contacts` (base) no registra quién lo
     * hizo — se deja constancia aquí vía log estructurado (organizationId,
     * actor, keep/absorb), mismo criterio de observabilidad que el resto del
     * proyecto (AGENTS.md §14).
     */
    fastify.post('/api/organizations/:id/contacts/merge', async (request, reply) => {
        const paramsResult = orgIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;

        const hasRole = await requireOrganizationRole(fastify, auth.jwt, organizationId, auth.userId, ['owner', 'admin']);
        if (!hasRole) {
            return reply.status(403).send({ success: false, error: 'Solo un administrador o propietario de la organización puede fusionar contactos.' });
        }

        const bodyResult = contactMergeBodySchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ success: false, error: bodyResult.error.issues[0]?.message ?? 'Cuerpo de la petición inválido.' });
        }
        const { keepContactId, absorbContactId } = bodyResult.data;

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data: bothContacts, error: fetchError } = await scopedClient
            .from('contacts')
            .select('id')
            .eq('organization_id', organizationId)
            .in('id', [keepContactId, absorbContactId]);

        if (fetchError || (bothContacts?.length ?? 0) !== 2) {
            return reply.status(404).send({ success: false, error: 'Uno o ambos contactos no pertenecen a esta organización.' });
        }

        const { error: mergeError } = await scopedClient.rpc('merge_contacts', {
            p_org_id: organizationId,
            p_keep_id: keepContactId,
            p_absorb_id: absorbContactId,
        });

        if (mergeError) {
            request.log.error({ organizationId, keepContactId, absorbContactId, err: mergeError.message, msg: 'Error fusionando contactos' });
            return reply.status(500).send({ success: false, error: 'No se pudo completar la fusión de contactos.' });
        }

        request.log.info({
            organizationId,
            actorUserId: auth.userId,
            keepContactId,
            absorbContactId,
            msg: 'Fusión de contactos completada (merge_contacts)',
        });

        const { data: mergedContact } = await scopedClient.from('contacts').select('*').eq('id', keepContactId).single();

        return reply.send({ success: true, data: mergedContact });
    });

    /**
     * GET /api/organizations/:id/pipeline
     * Envuelve v_pipeline_kanban.
     */
    fastify.get('/api/organizations/:id/pipeline', async (request, reply) => {
        const paramsResult = orgIdParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'El parámetro de ruta "id" debe ser un UUID válido.' });
        }
        const { id: organizationId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;
        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data, error } = await scopedClient
            .from('v_pipeline_kanban')
            .select('*')
            .eq('organization_id', organizationId)
            .order('pipeline_updated_at', { ascending: false });

        if (error) {
            request.log.error({ organizationId, err: error.message, msg: 'Error consultando pipeline kanban' });
            return reply.status(500).send({ success: false, error: 'No se pudo consultar el pipeline.' });
        }

        return reply.send({ success: true, data: data ?? [] });
    });

    /**
     * GET /api/organizations/:id/contacts/:contactId
     * Detalle con timeline unificado: leads (conversaciones), citas, notas y
     * direcciones, ordenado por fecha descendente.
     */
    fastify.get('/api/organizations/:id/contacts/:contactId', async (request, reply) => {
        const paramsResult = orgContactParamsSchema.safeParse(request.params);
        if (!paramsResult.success) {
            return reply.status(400).send({ success: false, error: 'Los parámetros de ruta "id" y "contactId" deben ser UUID válidos.' });
        }
        const { id: organizationId, contactId } = paramsResult.data;

        const auth = await requireAuthenticatedUser(fastify, request, reply);
        if (!auth) return;
        const isMember = await requireOrganizationMembership(fastify, auth.jwt, organizationId);
        if (!isMember) {
            return reply.status(403).send({ success: false, error: 'No pertenece a esta organización, o no existe.' });
        }

        const scopedClient = fastify.supabaseUser(auth.jwt);
        const { data: contact, error: contactError } = await scopedClient
            .from('contacts')
            .select('*')
            .eq('id', contactId)
            .eq('organization_id', organizationId)
            .maybeSingle();

        if (contactError || !contact) {
            return reply.status(404).send({ success: false, error: 'Contacto no encontrado en esta organización.' });
        }

        const [leadsResult, appointmentsResult, notesResult, addressesResult] = await Promise.all([
            scopedClient
                .from('leads')
                .select('id, channel, conversation_id, inquiry_reason, temperature, booked_appointment, created_at')
                .eq('organization_id', organizationId)
                .eq('contact_id', contactId)
                .order('created_at', { ascending: false }),
            scopedClient
                .from('appointments')
                .select('id, status, start_time, end_time, service_address, created_at')
                .eq('organization_id', organizationId)
                .eq('contact_id', contactId)
                .order('start_time', { ascending: false }),
            scopedClient
                .from('contact_notes')
                .select('id, body, author_user_id, created_at')
                .eq('organization_id', organizationId)
                .eq('contact_id', contactId)
                .order('created_at', { ascending: false }),
            scopedClient
                .from('contact_addresses')
                .select('*')
                .eq('organization_id', organizationId)
                .eq('contact_id', contactId)
                .is('archived_at', null)
                .order('is_primary', { ascending: false }),
        ]);

        const timeline = [
            ...(leadsResult.data ?? []).map((lead) => ({ type: 'conversation' as const, occurredAt: lead.created_at, data: lead })),
            ...(appointmentsResult.data ?? []).map((appt) => ({ type: 'appointment' as const, occurredAt: appt.created_at, data: appt })),
            ...(notesResult.data ?? []).map((note) => ({ type: 'note' as const, occurredAt: note.created_at, data: note })),
        ].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

        return reply.send({
            success: true,
            data: {
                contact,
                addresses: addressesResult.data ?? [],
                timeline,
            },
        });
    });
}

export default contactsCrmRoutes;
