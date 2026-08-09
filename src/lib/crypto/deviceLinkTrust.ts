import { supabase } from '@/integrations/supabase/client';
import { peekDeviceSignedPrekey } from './x3dh';

/**
 * Confiance appareil canonique Aegis.
 *
 * Invariant : la confiance provient uniquement de la ligne `user_devices`
 * (approuvée, active, non révoquée, bindée, routable, clés + signature
 * d'autorisation présentes) plus une SPK exploitable. Aucune liste signée,
 * aucune racine d'identité, aucun appareil « primaire ».
 */

const DEVICE_TRUST_COLUMNS =
  'device_id,is_active,revoked_at,stale_at,approval_status,binding_status,routing_status,' +
  'device_public_key,device_signing_key,device_authorization_signature';

type CanonicalDeviceRow = {
  device_id: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  stale_at: string | null;
  approval_status: string | null;
  binding_status: string | null;
  routing_status: string | null;
  device_public_key: string | null;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
};

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isCanonicalTrustedDevice(row: CanonicalDeviceRow | null | undefined): boolean {
  if (!row) return false;
  return row.is_active === true
    && row.revoked_at == null
    && row.stale_at == null
    && row.approval_status === 'approved'
    && row.binding_status === 'bound'
    && row.routing_status === 'ready'
    && filled(row.device_public_key)
    && filled(row.device_signing_key)
    && filled(row.device_authorization_signature);
}

async function fetchCanonicalDevices(userId: string): Promise<CanonicalDeviceRow[]> {
  const { data, error } = await supabase
    .from('user_devices')
    .select(DEVICE_TRUST_COLUMNS)
    .eq('user_id', userId);
  if (error) throw new Error(`DEVICE_TRUST_LOOKUP_FAILED:${error.message}`);
  return (data ?? []) as CanonicalDeviceRow[];
}

export async function ensureApprovedDeviceTrust(
  userId: string,
  deviceId: string,
): Promise<number> {
  if (!userId || !deviceId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const [rows, spk] = await Promise.all([
    fetchCanonicalDevices(userId),
    peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  ]);
  const row = rows.find(entry => entry.device_id === deviceId) ?? null;
  if (!row) throw new Error('DEVICE_IDENTITY_UNVERIFIED:MISSING');
  if (!isCanonicalTrustedDevice(row)) throw new Error('DEVICE_ROUTE_NOT_AUTHORIZED');
  if (!spk) throw new Error('DEVICE_SIGNED_PREKEY_UNAVAILABLE');
  return 0;
}

/**
 * Vérifie la santé du registre sans laisser une ligne historique invalide
 * bloquer toutes les routes valides. Retourne le nombre d'entrées invalides.
 */
export async function repairApprovedDeviceTrust(userId: string): Promise<number> {
  const rows = await fetchCanonicalDevices(userId);
  const invalidCount = rows.filter(row => !isCanonicalTrustedDevice(row)).length;
  if (!rows.some(row => isCanonicalTrustedDevice(row))) {
    throw new Error('DEVICE_REGISTRY_CONTAINS_NO_VALID_ROUTE');
  }
  return invalidCount;
}
