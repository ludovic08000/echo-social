/**
 * Vérification automatique de cohérence des clés (serveur <-> client).
 *
 * Invariant vérifié : l'appareil courant doit toujours posséder, côté serveur,
 * une identité active, une autorisation d'appareil signée par CETTE identité,
 * une pré-clé signée valide et une entrée dans la liste d'appareils signée.
 * Si un de ces éléments manque ou est périmé (typiquement après un reset
 * d'identité), on déclenche la ré-autorisation locale AVANT qu'un envoi
 * n'échoue. Aucune clé n'est jamais régénérée ni révoquée ici.
 */

import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';

export interface KeyConsistencyReport {
  ok: boolean;
  device_id: string;
  identity_fingerprint: string | null;
  signed_prekeys: number;
  one_time_prekeys: number;
  signed_list_version: number | null;
  issues: string[];
}

/** Problèmes réparables par une simple ré-publication locale. */
const REPAIRABLE_ISSUES = new Set([
  'device_not_registered',
  'missing_device_signing_key',
  'missing_device_authorization',
  'stale_device_authorization',
  'missing_signed_prekey',
  'low_one_time_prekeys',
  'missing_signed_device_list',
  'device_absent_from_signed_list',
]);

let inFlight: Promise<KeyConsistencyReport | null> | null = null;
let lastRepairAt = 0;
let timer: number | undefined;

export async function checkKeyConsistency(): Promise<KeyConsistencyReport | null> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const deviceId = getCurrentDeviceId();
      if (!deviceId || isDeviceIdTemporary()) return null;

      const { data: auth } = await supabase.auth.getSession();
      if (!auth?.session?.user) return null;

      const { data, error } = await (supabase.rpc as any)('verify_own_key_consistency', {
        p_device_id: deviceId,
      });
      if (error) throw error;
      if (!data) return null;

      const report: KeyConsistencyReport = {
        ok: Boolean(data.ok),
        device_id: String(data.device_id ?? deviceId),
        identity_fingerprint: data.identity_fingerprint ?? null,
        signed_prekeys: Number(data.signed_prekeys ?? 0),
        one_time_prekeys: Number(data.one_time_prekeys ?? 0),
        signed_list_version: data.signed_list_version ?? null,
        issues: Array.isArray(data.issues) ? data.issues.map(String) : [],
      };

      if (!report.ok) {
        console.warn('[KEY_SYNC] server/client key mismatch', report.issues);
        maybeRequestRepair(report);
      }

      return report;
    } catch (error) {
      console.warn('[KEY_SYNC] consistency check failed', error);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function maybeRequestRepair(report: KeyConsistencyReport): void {
  if (typeof window === 'undefined') return;

  const repairable = report.issues.filter((issue) => REPAIRABLE_ISSUES.has(issue));
  if (repairable.length === 0) return;

  const now = Date.now();
  if (now - lastRepairAt < 30_000) return;
  lastRepairAt = now;

  window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
    detail: { reason: `key-consistency:${repairable[0]}`, deviceId: report.device_id },
  }));
}

/**
 * Démarre la surveillance périodique. Idempotent.
 * Retourne une fonction d'arrêt.
 */
export function startKeyConsistencyGuard(intervalMs = 5 * 60_000): () => void {
  if (typeof window === 'undefined') return () => {};

  const run = () => { void checkKeyConsistency(); };
  const onFocus = () => {
    if (document.visibilityState === 'visible') run();
  };

  // Premier passage différé : laisse l'enregistrement d'appareil se terminer.
  const bootTimer = window.setTimeout(run, 4_000);
  if (timer !== undefined) window.clearInterval(timer);
  timer = window.setInterval(run, intervalMs);
  window.addEventListener('visibilitychange', onFocus);
  window.addEventListener('forsure-keys-restored', run);
  window.addEventListener('forsure:e2ee-post-restore', run);

  return () => {
    window.clearTimeout(bootTimer);
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    window.removeEventListener('visibilitychange', onFocus);
    window.removeEventListener('forsure-keys-restored', run);
    window.removeEventListener('forsure:e2ee-post-restore', run);
  };
}
