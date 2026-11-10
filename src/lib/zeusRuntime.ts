import { z } from 'zod';
import { supabase } from '@/integrations/supabase/client';
import { capabilityForCommand, type ZeusCapabilityCommandType } from '@/lib/zeusCapabilities';

export async function requireZeusCapability(type: ZeusCapabilityCommandType, fromVoice = false) {
  const capability = capabilityForCommand(type);
  const { data, error } = await supabase.rpc('zeus_capability_state', { p_capability: capability.id, p_from_voice: fromVoice });
  const parsed = z.object({ allowed: z.boolean(), requires_confirmation: z.boolean(), revision: z.number().int().positive(), checked_at: z.string().refine(value=>Number.isFinite(Date.parse(value))) }).safeParse(data);
  if (error || !parsed.success) throw new Error('Les droits de cette commande ne sont pas confirmés par le serveur.');
  if (!parsed.data.allowed) throw new Error('Cette commande n’est pas disponible avec les droits actuels de ton compte.');
  return { ...capability, requiresConfirmation: capability.requiresConfirmation || parsed.data.requires_confirmation, serverPreparedAt:Date.parse(parsed.data.checked_at) };
}

export async function claimZeusCommand(key: string, type: ZeusCapabilityCommandType, fingerprint: string, preparedAt: number, fromVoice: boolean, confirmed: boolean) {
  const { data, error } = await supabase.rpc('zeus_claim_command', {
    p_key: key, p_capability: capabilityForCommand(type).id, p_fingerprint: fingerprint,
    p_prepared_at: new Date(preparedAt).toISOString(), p_from_voice: fromVoice, p_confirmed: confirmed,
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data) || data.claimed !== true) {
    throw new Error('Cette commande n’a pas été autorisée ou a déjà été lancée. Vérifie son résultat avant de recommencer.');
  }
}
