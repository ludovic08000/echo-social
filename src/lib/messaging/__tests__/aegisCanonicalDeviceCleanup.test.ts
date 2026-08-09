import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const app = read('src/App.tsx');
const deviceIdStore = read('src/lib/messaging/currentDevice.ts');
const managedDevice = read('src/lib/device-manager/currentDevice.ts');
const enrollment = read('src/lib/crypto/serverDeviceEnrollment.ts');
const deviceTrust = read('src/lib/crypto/deviceLinkTrust.ts');
const realtime = read('src/lib/messaging/realtimeKeySync.ts');
const migration = read(
  'docs/pending-migrations/20260809120000_aegis_canonical_device_cleanup.sql',
);

describe('Aegis canonical device cleanup', () => {
  it('removes the legacy device modules from the tree', () => {
    for (const path of [
      'src/hooks/useDeviceRegistration.ts',
      'src/hooks/useDeviceLink.ts',
      'src/lib/crypto/deviceLinkEnvelope.ts',
      'src/lib/messaging/messagingApi.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), path))).toBe(false);
    }
  });

  it('starts the messaging runtime only through the canonical façade', () => {
    expect(app).toContain("from '@/lib/api/messagingApi'");
    expect(app).toContain('messagingApi.startRuntime(user.id)');
    expect(app).not.toContain('startRealtimeKeySync(');
    expect(app).not.toContain('startAegisDeviceInbox(');
    expect(app).not.toContain('useDeviceRegistration');
    expect(app).not.toContain('usePendingDeviceApprovalAlert');
  });

  it('never derives device identity or trust from hardware signals', () => {
    for (const symbol of [
      'getDeviceFingerprint',
      'getDeviceFingerprintCandidates',
      'computeDeviceFingerprints',
      'adoptDeviceIdFromBackup',
      'rotateCurrentDeviceId',
      'FINGERPRINT_KEY',
    ]) {
      expect(deviceIdStore).not.toContain(symbol);
      expect(managedDevice).not.toContain(symbol);
    }
    expect(enrollment).not.toContain('deviceFingerprint');
    expect(enrollment).not.toContain('p_device_fingerprint');
  });

  it('validates device trust directly against user_devices', () => {
    expect(deviceTrust).not.toContain('signedDeviceList');
    expect(deviceTrust).not.toContain('finalizeLinkedDeviceAfterRestore');
    expect(deviceTrust).toContain("approval_status === 'approved'");
    expect(deviceTrust).toContain("binding_status === 'bound'");
    expect(deviceTrust).toContain("routing_status === 'ready'");
    expect(deviceTrust).toContain('DEVICE_SIGNED_PREKEY_UNAVAILABLE');
  });

  it('drops the legacy realtime device tables', () => {
    expect(realtime).not.toContain('user_device_signatures');
    expect(realtime).not.toContain('signed_device_lists');
  });

  it('ships a forward-only migration that drops the legacy device model', () => {
    for (const statement of [
      'DROP TABLE IF EXISTS public.signed_device_lists;',
      'DROP TABLE IF EXISTS public.user_device_signatures;',
      'DROP TABLE IF EXISTS public.user_identity_roots;',
      'DROP TABLE IF EXISTS public.device_link_requests;',
      'DROP TABLE IF EXISTS public.device_link_tokens;',
      'DROP TABLE IF EXISTS public.device_primary_repair_requests;',
      'DROP TRIGGER IF EXISTS aegis_reconcile_device_root ON public.user_devices;',
      'DROP COLUMN IF EXISTS device_fingerprint',
      'DROP COLUMN IF EXISTS is_primary',
      'DROP COLUMN IF EXISTS possession_payload_version',
    ]) {
      expect(migration).toContain(statement);
    }
    expect(migration).not.toContain('CASCADE');
    // Le fingerprint cryptographique de compte ne doit jamais être supprimé.
    expect(migration).not.toContain('user_public_keys');
    for (const grant of [
      'GRANT EXECUTE ON FUNCTION public.begin_user_device_enrollment(text, text, text) TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid) TO authenticated;',
      'GRANT EXECUTE ON FUNCTION public.revoke_user_device(text) TO authenticated;',
    ]) {
      expect(migration).toContain(grant);
    }
  });
});
