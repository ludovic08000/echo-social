import { supabase } from '@/integrations/supabase/client';

/**
 * Publication idempotente de l'identité publique Aegis.
 *
 * Le navigateur n'écrit jamais directement dans `user_public_keys`. Le RPC
 * vérifie la liaison Ed25519 et n'accepte une création que si le compte n'a
 * encore aucune identité. Une racine différente exige le parcours explicite
 * de rotation/récupération.
 */
export type PublishableIdentityRow = {
  user_id: string;
  identity_key: string;
  signing_key: string;
  fingerprint: string;
  identity_binding_version: number;
  identity_binding_signature: string;
  kem_type: string;
  is_active: true;
  updated_at: string;
};

export async function publishActiveIdentityKey(row: PublishableIdentityRow): Promise<void> {
  const { data, error } = await supabase.rpc(
    'publish_own_identity_key_v2' as never,
    {
      p_identity_key: row.identity_key,
      p_signing_key: row.signing_key,
      p_fingerprint: row.fingerprint,
      p_binding_version: row.identity_binding_version,
      p_binding_signature: row.identity_binding_signature,
      p_kem_type: row.kem_type,
    } as never,
  );

  if (error) throw new Error(`IDENTITY_PUBLICATION_FAILED:${error.message}`);

  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    throw new Error(
      typeof result?.code === 'string' ? result.code : 'IDENTITY_PUBLICATION_REJECTED',
    );
  }
  if (result.fingerprint !== row.fingerprint) {
    throw new Error('IDENTITY_PUBLICATION_FINGERPRINT_MISMATCH');
  }
}
