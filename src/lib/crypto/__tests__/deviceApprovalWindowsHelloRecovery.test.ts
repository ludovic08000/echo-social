import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const approval = readFileSync('src/lib/crypto/deviceApprovalDecision.ts', 'utf8');

describe('device approval Windows Hello recovery', () => {
  it('restores the account private key before authorizing a pending device', () => {
    expect(approval).toMatch(/import\(\s*['"]@\/lib\/crypto\/windowsHelloDeviceRecovery['"]\s*\)/);
    expect(approval).toContain('recoverCurrentWindowsHelloDevice(args.userId)');
    expect(approval).toContain('recoveredDeviceId !== args.approverDeviceId');
    expect(approval).toContain("throw new Error('DEVICE_APPROVAL_WINDOWS_HELLO_DEVICE_MISMATCH')");
    expect(approval).toMatch(/recoverCurrentWindowsHelloDevice[\s\S]*loadIdentityKeys\(args\.userId\)/);
  });
});
