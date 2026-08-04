import { supabase } from '@/integrations/supabase/client';

/**
 * Invariant corrigé : l'unicité de la clé active est portée par un index PARTIEL
 * (user_id WHERE is_active), qu'un upsert PostgREST ne peut pas cibler.
 * On écrit donc explicitement la ligne active : update sinon insert.
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
  const { data: updated, error: updateError } = await supabase
    .from('user_public_keys')
    .update({
      identity_key: row.identity_key,
      signing_key: row.signing_key,
      fingerprint: row.fingerprint,
      identity_binding_version: row.identity_binding_version,
      identity_binding_signature: row.identity_binding_signature,
      kem_type: row.kem_type,
      updated_at: row.updated_at,
    })
    .eq('user_id', row.user_id)
    .eq('is_active', true)
    .select('id');

  if (updateError) throw updateError;
  if (updated && updated.length > 0) return;

  const { error: insertError } = await supabase
    .from('user_public_keys')
    .insert(row);

  if (insertError) {
    // Course possible avec une autre publication concurrente : la ligne active
    // existe déjà, l'invariant est satisfait.
    if (insertError.code === '23505') return;
    throw insertError;
  }
}
