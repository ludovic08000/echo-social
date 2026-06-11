import { supabase } from '@/integrations/supabase/client';
import { rpcEnsureUserCryptoState, rpcMarkUserCryptoReady } from './rpcTyped';

export type ServerCryptoStatus = 'needs_client_key' | 'ready' | 'error';

export interface ServerCryptoState {
  userId: string;
  keySlotId: string;
  identityEpoch: number;
  status: ServerCryptoStatus;
  clientKeyPublishedAt: string | null;
  updatedAt: string;
}

function normalize(row: any): ServerCryptoState {
  return {
    userId: row.user_id,
    keySlotId: row.key_slot_id,
    identityEpoch: Number(row.identity_epoch || 1),
    status: row.status || 'needs_client_key',
    clientKeyPublishedAt: row.client_key_published_at || null,
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

export async function ensureServerCryptoState(): Promise<ServerCryptoState | null> {
  try {
    const { data, error } = await rpcEnsureUserCryptoState();
    if (error) throw error;
    return data ? normalize(data) : null;
  } catch (error) {
    console.warn('[E2EE][SERVER_STATE] ensure failed', error);
    return null;
  }
}

export async function markServerCryptoReady(fingerprint: string): Promise<ServerCryptoState | null> {
  try {
    const { data, error } = await rpcMarkUserCryptoReady({ p_fingerprint: fingerprint });
    if (error) throw error;
    return data ? normalize(data) : null;
  } catch (error) {
    console.warn('[E2EE][SERVER_STATE] mark ready failed', error);
    return null;
  }
}

export async function fetchServerCryptoState(userId: string): Promise<ServerCryptoState | null> {
  try {
    const { data, error } = await supabase
      .from('user_crypto_state' as any)
      .select('user_id, key_slot_id, identity_epoch, status, client_key_published_at, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;
    return data ? normalize(data) : null;
  } catch (error) {
    console.warn('[E2EE][SERVER_STATE] fetch failed', error);
    return null;
  }
}
