import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const approval = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');
const gate = readFileSync('src/components/messaging/DeviceApprovalGate.tsx', 'utf8');

describe('device approval after automatic approval rollout', () => {
  it('drops the account-key ceremony from the approval path', () => {
    expect(approval).not.toContain('recoverCurrentWindowsHelloDevice');
    expect(approval).not.toContain('loadIdentityKeys');
    expect(approval).toContain('submitAutomaticDeviceApproval');
  });

  it('keeps the Windows Hello recovery screen untouched', () => {
    expect(gate).toContain('recoverCurrentWindowsHelloDevice(user.id)');
    expect(gate).toContain('isWindowsWeb()');
  });
});
