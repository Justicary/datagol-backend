import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    getCredentialGroupOwner,
    isCredentialGroupOwner,
    getOrganizationName,
    clearCredentialGroupOwnerCache,
} from '../src/services/credential-group-service.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * docs/tasks/catalogo-productos-grupos-cred.md FASE B.1: resolución de la
 * organización dueña del grupo de credenciales. Se crea un grupo COMPARTIDO
 * real (owner + un miembro no-owner) contra la base viva, en vez de mockear
 * Supabase — mismo criterio que el resto de la suite (secret-keys.test.ts,
 * webhooks-elevenlabs.test.ts).
 */
describe('src/services/credential-group-service.ts', () => {
    let groupId: string;
    let ownerOrgId: string;
    let memberOrgId: string;

    beforeAll(async () => {
        const { data: group, error: groupErr } = await supabaseAdmin
            .from('credential_groups')
            .insert({ name: 'Grupo diagnóstico (credential-group-service.test.ts)' })
            .select('id')
            .single();
        if (groupErr || !group) throw new Error(`No se pudo crear el grupo de prueba: ${groupErr?.message}`);
        groupId = group.id;

        const { data: owner, error: ownerErr } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Owner (credential-group-service.test.ts)', email: `owner-cgs-test-${Date.now()}@example.invalid`, credential_group_id: groupId })
            .select('id')
            .single();
        if (ownerErr || !owner) throw new Error(`No se pudo crear la organización owner: ${ownerErr?.message}`);
        ownerOrgId = owner.id;

        const { error: updateGroupErr } = await supabaseAdmin
            .from('credential_groups')
            .update({ owner_organization_id: ownerOrgId })
            .eq('id', groupId);
        if (updateGroupErr) throw new Error(`No se pudo fijar el owner del grupo: ${updateGroupErr.message}`);

        const { data: member, error: memberErr } = await supabaseAdmin
            .from('organizations')
            .insert({ name: 'Miembro (credential-group-service.test.ts)', email: `member-cgs-test-${Date.now()}@example.invalid`, credential_group_id: groupId })
            .select('id')
            .single();
        if (memberErr || !member) throw new Error(`No se pudo crear la organización miembro: ${memberErr?.message}`);
        memberOrgId = member.id;
    });

    afterAll(async () => {
        if (memberOrgId) await supabaseAdmin.from('organizations').delete().eq('id', memberOrgId);
        if (ownerOrgId) await supabaseAdmin.from('organizations').delete().eq('id', ownerOrgId);
        if (groupId) await supabaseAdmin.from('credential_groups').delete().eq('id', groupId);
        clearCredentialGroupOwnerCache();
    });

    it('getCredentialGroupOwner del owner devuelve el propio owner (caso trivial de grupo de uno también pasa por aquí)', async () => {
        const result = await getCredentialGroupOwner(ownerOrgId);
        expect(result).not.toBeNull();
        expect(result!.groupId).toBe(groupId);
        expect(result!.ownerOrganizationId).toBe(ownerOrgId);
    });

    it('getCredentialGroupOwner de un miembro no-owner también resuelve al owner del grupo', async () => {
        const result = await getCredentialGroupOwner(memberOrgId);
        expect(result).not.toBeNull();
        expect(result!.groupId).toBe(groupId);
        expect(result!.ownerOrganizationId).toBe(ownerOrgId);
    });

    it('isCredentialGroupOwner es true para el owner', async () => {
        expect(await isCredentialGroupOwner(ownerOrgId)).toBe(true);
    });

    it('contraparte: isCredentialGroupOwner es false para un miembro no-owner', async () => {
        expect(await isCredentialGroupOwner(memberOrgId)).toBe(false);
    });

    it('getCredentialGroupOwner devuelve null para una organización inexistente, sin lanzar', async () => {
        const result = await getCredentialGroupOwner('00000000-0000-0000-0000-000000000000');
        expect(result).toBeNull();
    });

    it('getOrganizationName devuelve el nombre real', async () => {
        expect(await getOrganizationName(ownerOrgId)).toBe('Owner (credential-group-service.test.ts)');
    });

    it('getOrganizationName devuelve null para una organización inexistente', async () => {
        expect(await getOrganizationName('00000000-0000-0000-0000-000000000000')).toBeNull();
    });
});
