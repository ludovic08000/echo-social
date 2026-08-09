import { describe, expect, it } from 'vitest';
import {
  computeDeviceApprovalFingerprint,
  formatDeviceApprovalFingerprint,
} from '@/lib/crypto/deviceApprovalFingerprint';

const keys = {
  deviceId: 'dev_0123456789abcdef0123456789abcdef',
  devicePublicKey: 'AAAAB3NzaC1kX25519PublicKeyBase64==',
  deviceSigningKey: 'AAAAC3NzaC1lZDI1NTE5SigningKey==',
};
const FINGERPRINT_TIMEOUT_MS = 20_000;

describe('device approval fingerprint', () => {
  it('renders 6 groups of 5 digits', async () => {
    const value = await computeDeviceApprovalFingerprint(keys);
    const groups = value.split(' ');
    expect(groups).toHaveLength(6);
    for (const group of groups) expect(group).toMatch(/^\d{5}$/);
  }, FINGERPRINT_TIMEOUT_MS);

  it('is identical on the pending device and on the approver for the same keys', async () => {
    const pendingLocal = await computeDeviceApprovalFingerprint(keys);
    const approverRemote = await computeDeviceApprovalFingerprint({ ...keys });
    expect(approverRemote).toBe(pendingLocal);
  }, FINGERPRINT_TIMEOUT_MS);

  it('changes when any key is substituted', async () => {
    const base = await computeDeviceApprovalFingerprint(keys);
    expect(await computeDeviceApprovalFingerprint({ ...keys, devicePublicKey: 'other-x25519' })).not.toBe(base);
    expect(await computeDeviceApprovalFingerprint({ ...keys, deviceSigningKey: 'other-ed25519' })).not.toBe(base);
    expect(await computeDeviceApprovalFingerprint({ ...keys, deviceId: 'dev_ffffffffffffffffffffffffffffffff' })).not.toBe(base);
  }, FINGERPRINT_TIMEOUT_MS);

  it('rejects incomplete input', async () => {
    await expect(computeDeviceApprovalFingerprint({ ...keys, deviceSigningKey: '' }))
      .rejects.toThrow('DEVICE_FINGERPRINT_INPUT_INCOMPLETE');
  });

  it('formats into two readable lines', async () => {
    const lines = formatDeviceApprovalFingerprint(await computeDeviceApprovalFingerprint(keys));
    expect(lines).toHaveLength(2);
    expect(lines[0].split(' ')).toHaveLength(3);
  }, FINGERPRINT_TIMEOUT_MS);
});
