import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync('src/App.tsx', 'utf8');
const gate = readFileSync('src/components/security/PendingDeviceApprovalGate.tsx', 'utf8');
const recovery = readFileSync('src/components/messages/E2EERestorePromptDialog.tsx', 'utf8');

describe('pending device approval UI architecture', () => {
  it('mounts a global, non-dismissible gate after device registration starts', () => {
    const registrationRunner = app.indexOf('<AccountKeySyncRunner />');
    const approvalGate = app.indexOf('<PendingDeviceApprovalGate />');

    expect(registrationRunner).toBeGreaterThan(-1);
    expect(approvalGate).toBeGreaterThan(registrationRunner);
    expect(gate).toContain('fixed inset-0 z-[120]');
    expect(gate).toContain('aria-modal="true"');
    expect(gate).not.toContain('DialogClose');
  });

  it('shows the current pending device and waits for approval from Windows', () => {
    expect(gate).toContain("window.addEventListener('forsure:e2ee-device-pending'");
    expect(gate).toContain(".eq('device_id', hydrated)");
    expect(gate).toContain('Nouvel appareil détecté');
    expect(gate).toContain('À faire sur votre Windows');
    expect(gate).toContain('Appuyez sur <strong className="text-foreground">Approuver</strong>');
  });

  it('tracks approval, synchronization and revocation in real time', () => {
    expect(gate).toContain("window.addEventListener('forsure:e2ee-device-approved'");
    expect(gate).toContain("window.addEventListener('forsure:current-device-revoked'");
    expect(gate).toContain("window.addEventListener('forsure:account-sync-state'");
    expect(gate).toContain("table: 'user_devices'");
    expect(gate).toContain("syncStateRef.current === 'failed'");
    expect(gate).toContain("syncStateRef.current !== 'ready'");
    expect(gate).toContain("source: 'pending-device-gate-sync-retry'");
    expect(gate).toContain('Appareil révoqué');
  });

  it('keeps account recovery behind the approval gate', () => {
    expect(recovery).toContain('currentDeviceIsApproved');
    expect(recovery).toContain("data.approval_status === 'approved'");
    expect(recovery).toContain('z-[140] sm:max-w-md');
  });

  it('retires the obsolete token verification page', () => {
    expect(app).not.toContain('SecurityDeviceVerify');
    expect(app).toContain('<Route path="/security/device" element={<ProtectedRoute><Navigate to="/settings" replace /></ProtectedRoute>} />');
  });
});
