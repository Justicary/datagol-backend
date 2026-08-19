-- =============================================================================
-- Datagol — Migración: Operaciones atómicas de RBAC (invitaciones, roles,
-- overrides del superadmin)
-- =============================================================================
-- docs/tasks/RBAC-permisos.md, FASE C y FASE D.
--
-- La migración 45 dejó el catálogo de permisos, los overrides y las
-- invitaciones como TABLAS, pero ninguna operación que las escriba de forma
-- atómica junto con permission_audit_log. AGENTS.md prohíbe un ORM pesado y
-- pide SQL parametrizado; el patrón ya usado por create_organization_with_owner
-- (migración 08) y enforce_seat_limit (migración 45) es el correcto para
-- esto: una función `security definer` con las escrituras + el INSERT de
-- auditoría en la MISMA transacción implícita de la función — si el INSERT
-- en permission_audit_log falla, la excepción revierte también la
-- escritura principal, sin compensación manual en JS que pueda fallar por
-- separado.
--
-- Cada función devuelve `jsonb` con forma {success, error_code?, message?,
-- data?} — la capa HTTP (src/services/invitation-service.ts) nunca
-- necesita parsear un código de error crudo de Postgres.
--
-- Las funciones reciben el actor (`p_actor_id`) como parámetro explícito,
-- igual que create_organization_with_owner recibe `p_user_id`: se llaman
-- con `supabaseAdmin` (service_role, sin sesión de usuario), así que
-- `auth.uid()` sería NULL dentro de la función — no se puede depender de
-- `auth_role_in_org()` (que sí usa auth.uid()) para resolver el rol del
-- actor. El permiso genérico `manage_users` ya se verificó en código antes
-- de llamar a estas funciones (routes/organization-members.ts, vía
-- requirePermission) — las guardas de AQUÍ son las reglas de negocio
-- específicas que ni RLS ni `has_permission()` conocen (nadie cambia su
-- propio rol, un admin no toca a un owner, nunca sin owner).
-- =============================================================================


-- =============================================================================
-- create_invitation — POST /organizations/:id/invitations
-- =============================================================================
create or replace function create_invitation(
  p_org_id     uuid,
  p_email      text,
  p_role       text,
  p_token_hash text,
  p_invited_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit int;
  v_used  int;
  v_invitation organization_invitations;
begin
  if p_role = 'owner' then
    return jsonb_build_object(
      'success', false,
      'error_code', 'OWNER_INVITE_FORBIDDEN',
      'message', 'No se puede invitar directamente como owner. La transferencia de propiedad es un flujo aparte, con confirmación del owner actual.'
    );
  end if;

  select p.max_users into v_limit
  from organizations o join plans p on p.key = o.plan_key
  where o.id = p_org_id;
  v_limit := coalesce(v_limit, 2);
  v_used := organization_seats_used(p_org_id);

  if v_used >= v_limit then
    return jsonb_build_object(
      'success', false,
      'error_code', 'SEAT_LIMIT',
      'message', format('Límite de %s usuarios alcanzado para el plan contratado (usados: %s, incluye invitaciones pendientes).', v_limit, v_used),
      'data', jsonb_build_object('limit', v_limit, 'used', v_used)
    );
  end if;

  begin
    insert into organization_invitations (organization_id, email, role, token_hash, invited_by)
    values (p_org_id, p_email, p_role, p_token_hash, p_invited_by)
    returning * into v_invitation;
  exception
    when unique_violation then
      return jsonb_build_object(
        'success', false,
        'error_code', 'ALREADY_INVITED',
        'message', 'Ya existe una invitación pendiente para este correo en esta organización.'
      );
    when check_violation then
      return jsonb_build_object(
        'success', false,
        'error_code', 'SEAT_LIMIT',
        'message', format('Límite de %s usuarios alcanzado para el plan contratado.', v_limit),
        'data', jsonb_build_object('limit', v_limit, 'used', v_used)
      );
  end;

  insert into permission_audit_log (organization_id, role, action, reason, actor_user_id)
  values (p_org_id, p_role, 'user_invited', format('Invitación creada para %s como %s.', p_email, p_role), p_invited_by);

  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object(
      'id', v_invitation.id,
      'email', v_invitation.email,
      'role', v_invitation.role,
      'expiresAt', v_invitation.expires_at
    )
  );
end;
$$;

comment on function create_invitation(uuid, text, text, text, uuid) is
  'Crea una invitación + registra auditoría en una sola transacción. Rechaza role=owner y exceso de asientos con un jsonb estructurado, no una excepción cruda. docs/tasks/RBAC-permisos.md FASE C.';


-- =============================================================================
-- revoke_invitation — DELETE /organizations/:id/invitations/:invId
-- =============================================================================
create or replace function revoke_invitation(
  p_invitation_id uuid,
  p_actor_id      uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation organization_invitations;
begin
  select * into v_invitation from organization_invitations where id = p_invitation_id;

  if v_invitation.id is null then
    return jsonb_build_object('success', false, 'error_code', 'NOT_FOUND', 'message', 'Invitación no encontrada.');
  end if;
  if v_invitation.accepted_at is not null then
    return jsonb_build_object('success', false, 'error_code', 'ALREADY_ACCEPTED', 'message', 'Esta invitación ya fue aceptada, no se puede revocar.');
  end if;
  if v_invitation.revoked_at is not null then
    return jsonb_build_object('success', false, 'error_code', 'ALREADY_REVOKED', 'message', 'Esta invitación ya estaba revocada.');
  end if;

  update organization_invitations set revoked_at = now() where id = p_invitation_id;

  -- No existe una acción dedicada a "invitación revocada" en el CHECK
  -- constraint de permission_audit_log.action (migración 45, ya aplicada);
  -- 'user_removed' es la más cercana semánticamente ("alguien que iba a
  -- unirse, ya no lo hará") — se deja explícito en `reason`.
  insert into permission_audit_log (organization_id, role, action, reason, actor_user_id)
  values (v_invitation.organization_id, v_invitation.role, 'user_removed', format('Invitación revocada para %s.', v_invitation.email), p_actor_id);

  return jsonb_build_object('success', true);
end;
$$;

comment on function revoke_invitation(uuid, uuid) is
  'Revoca una invitación pendiente + audita en la misma transacción. docs/tasks/RBAC-permisos.md FASE C.';


-- =============================================================================
-- accept_invitation — POST /invitations/accept
-- =============================================================================
create or replace function accept_invitation(
  p_token_hash       text,
  p_accepting_user_id uuid,
  p_accepting_email   text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation organization_invitations;
begin
  select * into v_invitation
  from organization_invitations
  where token_hash = p_token_hash
    and accepted_at is null
    and revoked_at is null
    and expires_at > now();

  if v_invitation.id is null then
    return jsonb_build_object('success', false, 'error_code', 'INVALID_TOKEN', 'message', 'La invitación no existe, ya fue usada, fue revocada o expiró.');
  end if;

  if lower(v_invitation.email) != lower(p_accepting_email) then
    return jsonb_build_object('success', false, 'error_code', 'EMAIL_MISMATCH', 'message', 'El correo de la sesión no coincide con el correo invitado.');
  end if;

  begin
    insert into organization_members (organization_id, user_id, role)
    values (v_invitation.organization_id, p_accepting_user_id, v_invitation.role);
  exception
    when unique_violation then
      return jsonb_build_object('success', false, 'error_code', 'ALREADY_MEMBER', 'message', 'Ya eres miembro de esta organización.');
    when check_violation then
      return jsonb_build_object('success', false, 'error_code', 'SEAT_LIMIT', 'message', 'La organización ya no tiene asientos disponibles para aceptar esta invitación.');
  end;

  update organization_invitations set accepted_at = now() where id = v_invitation.id;

  insert into permission_audit_log (organization_id, role, action, target_user_id, reason, actor_user_id)
  values (v_invitation.organization_id, v_invitation.role, 'user_invited', p_accepting_user_id, 'Invitación aceptada.', p_accepting_user_id);

  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object('organizationId', v_invitation.organization_id, 'role', v_invitation.role)
  );
end;
$$;

comment on function accept_invitation(text, uuid, text) is
  'Acepta una invitación por token hasheado + crea la membresía + audita, todo en una transacción. Rechaza correo distinto, token inválido/expirado/usado, y exceso de asientos. docs/tasks/RBAC-permisos.md FASE C.';


-- =============================================================================
-- change_member_role — PATCH /organizations/:id/members/:memberId
-- =============================================================================
create or replace function change_member_role(
  p_org_id         uuid,
  p_member_user_id uuid,
  p_new_role       text,
  p_actor_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_role text;
  v_actor_role  text;
  v_owner_count int;
begin
  if p_member_user_id = p_actor_id then
    return jsonb_build_object('success', false, 'error_code', 'CANNOT_CHANGE_OWN_ROLE', 'message', 'No puedes cambiar tu propio rol. Pide a otro administrador u owner que lo haga.');
  end if;

  select role into v_target_role from organization_members where organization_id = p_org_id and user_id = p_member_user_id;
  if v_target_role is null then
    return jsonb_build_object('success', false, 'error_code', 'NOT_FOUND', 'message', 'El usuario no es miembro de esta organización.');
  end if;

  select role into v_actor_role from organization_members where organization_id = p_org_id and user_id = p_actor_id;

  if v_actor_role is distinct from 'owner' then
    if v_target_role = 'owner' then
      return jsonb_build_object('success', false, 'error_code', 'ADMIN_CANNOT_MODIFY_OWNER', 'message', 'Un admin no puede modificar al owner.');
    end if;
    if p_new_role = 'owner' then
      return jsonb_build_object('success', false, 'error_code', 'ADMIN_CANNOT_PROMOTE_TO_OWNER', 'message', 'Un admin no puede promover a nadie a owner. Solo el owner puede hacerlo.');
    end if;
  end if;

  if v_target_role = 'owner' and p_new_role != 'owner' then
    select count(*) into v_owner_count from organization_members where organization_id = p_org_id and role = 'owner';
    if v_owner_count <= 1 then
      return jsonb_build_object('success', false, 'error_code', 'LAST_OWNER', 'message', 'No se puede degradar al último owner de la organización. Asigna otro owner primero.');
    end if;
  end if;

  update organization_members set role = p_new_role where organization_id = p_org_id and user_id = p_member_user_id;

  -- role_changed no tiene columnas de texto dedicadas para el rol anterior/
  -- nuevo (previous_value/new_value son boolean, pensadas para overrides
  -- granted/revoked) — se documenta la transición en `reason`.
  insert into permission_audit_log (organization_id, role, action, target_user_id, reason, actor_user_id)
  values (p_org_id, p_new_role, 'role_changed', p_member_user_id, format('Rol cambiado de %s a %s.', v_target_role, p_new_role), p_actor_id);

  return jsonb_build_object('success', true, 'data', jsonb_build_object('userId', p_member_user_id, 'previousRole', v_target_role, 'newRole', p_new_role));
end;
$$;

comment on function change_member_role(uuid, uuid, text, uuid) is
  'Cambia el rol de un miembro con las guardas de negocio de FASE C (nadie su propio rol, admin no toca al owner ni promueve a owner, nunca sin owner) + audita en la misma transacción. docs/tasks/RBAC-permisos.md FASE C.';


-- =============================================================================
-- deactivate_member — DELETE /organizations/:id/members/:memberId
-- =============================================================================
-- organization_members no tiene columna de estado (activo/inactivo) — la
-- migración 45 no la agregó y esta tarea no la pide. "Desactivar" se
-- implementa como remover la membresía (coherente con el verbo HTTP DELETE
-- de la ruta); las guardas de owner/último-owner son las mismas que en
-- change_member_role.
create or replace function deactivate_member(
  p_org_id         uuid,
  p_member_user_id uuid,
  p_actor_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_role text;
  v_actor_role  text;
  v_owner_count int;
begin
  if p_member_user_id = p_actor_id then
    return jsonb_build_object('success', false, 'error_code', 'CANNOT_REMOVE_SELF', 'message', 'No puedes desactivarte a ti mismo. Pide a otro administrador u owner que lo haga.');
  end if;

  select role into v_target_role from organization_members where organization_id = p_org_id and user_id = p_member_user_id;
  if v_target_role is null then
    return jsonb_build_object('success', false, 'error_code', 'NOT_FOUND', 'message', 'El usuario no es miembro de esta organización.');
  end if;

  select role into v_actor_role from organization_members where organization_id = p_org_id and user_id = p_actor_id;

  if v_actor_role is distinct from 'owner' and v_target_role = 'owner' then
    return jsonb_build_object('success', false, 'error_code', 'ADMIN_CANNOT_MODIFY_OWNER', 'message', 'Un admin no puede desactivar al owner.');
  end if;

  if v_target_role = 'owner' then
    select count(*) into v_owner_count from organization_members where organization_id = p_org_id and role = 'owner';
    if v_owner_count <= 1 then
      return jsonb_build_object('success', false, 'error_code', 'LAST_OWNER', 'message', 'No se puede desactivar al último owner de la organización. Asigna otro owner primero.');
    end if;
  end if;

  delete from organization_members where organization_id = p_org_id and user_id = p_member_user_id;

  insert into permission_audit_log (organization_id, role, action, target_user_id, reason, actor_user_id)
  values (p_org_id, v_target_role, 'user_removed', p_member_user_id, 'Miembro desactivado (membresía eliminada).', p_actor_id);

  return jsonb_build_object('success', true);
end;
$$;

comment on function deactivate_member(uuid, uuid, uuid) is
  'Remueve la membresía de un usuario con las mismas guardas de owner que change_member_role + audita en la misma transacción. docs/tasks/RBAC-permisos.md FASE C.';


-- =============================================================================
-- apply_permission_override — PATCH /admin/organizations/:id/permissions
-- =============================================================================
create or replace function apply_permission_override(
  p_org_id         uuid,
  p_role           text,
  p_permission_key text,
  p_enabled        boolean,
  p_reason         text,
  p_expires_at     timestamptz,
  p_actor_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous boolean;
begin
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('success', false, 'error_code', 'REASON_REQUIRED', 'message', 'El campo "reason" es obligatorio para todo override.');
  end if;

  -- Invariante de owner (has_permission() en migración 45 ya lo neutraliza
  -- en runtime): el intento se RECHAZA explícitamente en vez de aceptarse
  -- silenciosamente sin efecto — así el superadmin ve por qué no cambió nada.
  if p_role = 'owner' and p_permission_key in ('manage_users', 'change_plan') and p_enabled = false then
    return jsonb_build_object(
      'success', false,
      'error_code', 'OWNER_INVARIANT',
      'message', format('El owner nunca pierde "%s" — has_permission() lo garantiza incondicionalmente. No se puede revocar mediante override.', p_permission_key)
    );
  end if;

  select enabled into v_previous
  from organization_role_permissions
  where organization_id = p_org_id and role = p_role and permission_key = p_permission_key;

  insert into organization_role_permissions (organization_id, role, permission_key, enabled, reason, expires_at, granted_by)
  values (p_org_id, p_role, p_permission_key, p_enabled, p_reason, p_expires_at, p_actor_id)
  on conflict (organization_id, role, permission_key)
  do update set enabled = excluded.enabled, reason = excluded.reason, expires_at = excluded.expires_at, granted_by = excluded.granted_by, updated_at = now();

  insert into permission_audit_log (organization_id, role, permission_key, action, previous_value, new_value, reason, actor_user_id)
  values (p_org_id, p_role, p_permission_key, case when p_enabled then 'granted' else 'revoked' end, v_previous, p_enabled, p_reason, p_actor_id);

  return jsonb_build_object('success', true);
end;
$$;

comment on function apply_permission_override(uuid, text, text, boolean, text, timestamptz, uuid) is
  'Upsert de un override de permiso por organización + audita en la misma transacción. Rechaza explícitamente el intento de revocar manage_users/change_plan al owner (invariante) y exige reason. docs/tasks/RBAC-permisos.md FASE D.';
