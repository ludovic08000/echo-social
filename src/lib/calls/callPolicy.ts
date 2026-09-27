/**
 * Fail-safe kill switch for the call subsystem only.
 *
 * Setting VITE_AEGIS_CALLS_ENABLED=false removes no messaging capability and
 * never falls back to an unencrypted call path. A redeploy restores calls.
 */
export function isAegisCallingEnabled(): boolean {
  return String(import.meta.env.VITE_AEGIS_CALLS_ENABLED ?? 'true').toLowerCase() !== 'false';
}
