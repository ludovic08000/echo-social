import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { canonicalDeviceApprovalDecisionPayload } from '@/lib/crypto/deviceApprovalDecision';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';

interface DeviceRow {
  device_id: string;
  device_name: string | null;
  platform: string | null;
  approval_status: string | null;
  lifecycle_status: string | null;
  is_active: boolean;
  revoked_at: string | null;
}

interface BeginResult {
  ok?: boolean;
  code?: string;
  challenge_id?: string;
  device_id?: string;
  nonce?: string;
  expires_at?: string;
}

interface RpcResult {
  ok?: boolean;
  code?: string;
  device_id?: string;
  challenge_id?: string;
  device_role?: string;
  binding_status?: string;
}

interface LogEntry {
  at: string;
  step: string;
  status: 'info' | 'ok' | 'error';
  data?: unknown;
}

const rpc = supabase.rpc as unknown as (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function rawPublicKeyBase64(key: CryptoKey): Promise<string> {
  const raw = await hardCrypto.exportKey('raw', key) as ArrayBuffer;
  return bufferToBase64(raw);
}

async function generateX25519PublicKey(): Promise<string> {
  const pair = await hardCrypto.generateKey(
    { name: 'X25519' } as Algorithm,
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  return rawPublicKeyBase64(pair.publicKey);
}

function canonicalPossessionPayload(args: {
  challengeId: string;
  deviceId: string;
  nonceHash: string;
  expiresAt: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-possession',
    challengeId: args.challengeId,
    deviceId: args.deviceId,
    nonceHash: args.nonceHash,
    expiresAt: new Date(args.expiresAt).toISOString(),
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  });
}

export default function E2EEDeviceEnrollmentTest() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [approverDeviceId, setApproverDeviceId] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);

  const readyDevices = useMemo(() => devices.filter((device) =>
    device.approval_status === 'approved' &&
    device.lifecycle_status === 'ready' &&
    device.is_active &&
    !device.revoked_at
  ), [devices]);

  const addLog = useCallback((step: string, status: LogEntry['status'], data?: unknown) => {
    setLogs((current) => [...current, {
      at: new Date().toISOString(),
      step,
      status,
      data,
    }]);
  }, []);

  const loadDevices = useCallback(async () => {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from('user_devices')
      .select('device_id,device_name,platform,approval_status,lifecycle_status,is_active,revoked_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (error) {
      addLog('devices:list', 'error', error.message);
      return;
    }

    const rows = (data ?? []) as DeviceRow[];
    setDevices(rows);
    const localReady = await Promise.all(rows
      .filter((row) => row.approval_status === 'approved' && row.lifecycle_status === 'ready' && row.is_active && !row.revoked_at)
      .map(async (row) => ({ row, identity: await loadDeviceIdentity(user.id, row.device_id).catch(() => null) })));
    const local = localReady.find((entry) => entry.identity)?.row.device_id ?? '';
    setApproverDeviceId(local);
    addLog('devices:list', 'ok', { total: rows.length, localReadyApprover: local || null });
  }, [addLog, user?.id]);

  const runTest = useCallback(async () => {
    if (!user?.id || running) return;
    setRunning(true);
    setLogs([]);
    let syntheticDeviceId: string | null = null;

    try {
      if (!approverDeviceId) throw new Error('Aucun appareil local ready avec clé privée disponible sur ce navigateur.');
      const approverIdentity = await loadDeviceIdentity(user.id, approverDeviceId);
      if (!approverIdentity) throw new Error('DEVICE_PRIVATE_KEY_MISSING_FOR_APPROVER');

      addLog('1.begin', 'info', { approverDeviceId });
      const begin = await rpc('begin_user_device_enrollment', {
        p_device_name: 'E2EE Web Test Device',
        p_platform: 'ios',
        p_user_agent: `EchoSocial-E2EE-Test/${navigator.userAgent}`.slice(0, 500),
      });
      if (begin.error) throw new Error(`BEGIN_FAILED:${begin.error.message}`);
      const challenge = begin.data as BeginResult;
      if (!challenge.ok || !challenge.challenge_id || !challenge.device_id || !challenge.nonce || !challenge.expires_at) {
        throw new Error(challenge.code || 'BEGIN_INVALID_RESPONSE');
      }
      syntheticDeviceId = challenge.device_id;
      addLog('1.begin', 'ok', challenge);

      addLog('2.keys', 'info');
      const signingPair = await hardCrypto.generateKey(
        { name: 'Ed25519' } as Algorithm,
        true,
        ['sign', 'verify'],
      ) as CryptoKeyPair;
      const [deviceSigningKey, devicePublicKey] = await Promise.all([
        rawPublicKeyBase64(signingPair.publicKey),
        generateX25519PublicKey(),
      ]);
      addLog('2.keys', 'ok', {
        signingKeyBytes: 32,
        kxKeyBytes: 32,
        privateKeysExported: false,
      });

      const nonceDigest = await hardCrypto.digest('SHA-256', encodeString(challenge.nonce)) as ArrayBuffer;
      const possessionPayload = canonicalPossessionPayload({
        challengeId: challenge.challenge_id,
        deviceId: challenge.device_id,
        nonceHash: bytesToHex(new Uint8Array(nonceDigest)),
        expiresAt: challenge.expires_at,
        devicePublicKey,
        deviceSigningKey,
      });
      const possessionSignature = bufferToBase64(await hardCrypto.sign(
        'Ed25519',
        signingPair.privateKey,
        encodeString(possessionPayload),
      ) as ArrayBuffer);

      addLog('3.complete', 'info');
      const complete = await rpc('complete_user_device_enrollment', {
        p_challenge_id: challenge.challenge_id,
        p_nonce: challenge.nonce,
        p_device_public_key: devicePublicKey,
        p_device_signing_key: deviceSigningKey,
        p_device_possession_signature: possessionSignature,
      });
      if (complete.error) throw new Error(`COMPLETE_FAILED:${complete.error.message}`);
      const staged = complete.data as RpcResult;
      if (!staged.ok || staged.code !== 'DEVICE_ENROLLMENT_STAGED') {
        throw new Error(staged.code || 'COMPLETE_REJECTED');
      }
      addLog('3.complete', 'ok', staged);

      const approvalPayload = canonicalDeviceApprovalDecisionPayload({
        userId: user.id,
        approverDeviceId,
        target: {
          deviceId: challenge.device_id,
          challengeId: challenge.challenge_id,
          devicePublicKey,
          deviceSigningKey,
        },
        decision: 'approve',
      });
      const approvalSignature = bufferToBase64(await hardCrypto.sign(
        'Ed25519',
        approverIdentity.privateKey,
        encodeString(approvalPayload),
      ) as ArrayBuffer);

      addLog('4.approve', 'info');
      const approval = await rpc('approve_device_enrollment_decision', {
        p_decision: 'approve',
        p_bootstrap_primary: false,
        p_approver_device_id: approverDeviceId,
        p_device_id: challenge.device_id,
        p_challenge_id: challenge.challenge_id,
        p_signature: approvalSignature,
      });
      if (approval.error) throw new Error(`APPROVE_FAILED:${approval.error.message}`);
      const approved = approval.data as RpcResult;
      if (!approved.ok || approved.code !== 'DEVICE_APPROVED') {
        throw new Error(approved.code || 'APPROVE_REJECTED');
      }
      addLog('4.approve', 'ok', approved);

      const { data: state, error: stateError } = await supabase
        .from('user_devices')
        .select('device_id,approval_status,lifecycle_status,is_active,binding_status,routing_status,routing_error,device_role,approved_by_device_id')
        .eq('user_id', user.id)
        .eq('device_id', challenge.device_id)
        .single();
      if (stateError) throw new Error(`STATE_READ_FAILED:${stateError.message}`);
      addLog('5.state', 'ok', state);

      addLog('6.cleanup', 'info', { deviceId: challenge.device_id });
      const cleanup = await rpc('revoke_user_device', { p_device_id: challenge.device_id });
      if (cleanup.error) {
        addLog('6.cleanup', 'error', cleanup.error.message);
      } else {
        addLog('6.cleanup', 'ok', cleanup.data);
      }
    } catch (error) {
      addLog('FAILED', 'error', error instanceof Error ? error.message : String(error));
      if (syntheticDeviceId) {
        const cleanup = await rpc('revoke_user_device', { p_device_id: syntheticDeviceId });
        addLog('cleanup-after-failure', cleanup.error ? 'error' : 'info', cleanup.error?.message ?? cleanup.data);
      }
    } finally {
      setRunning(false);
      await loadDevices();
    }
  }, [addLog, approverDeviceId, loadDevices, running, user?.id]);

  if (!user) return null;

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm text-muted-foreground">Diagnostic interne · aucun secret privé n’est affiché</p>
          <h1 className="text-2xl font-semibold">Test live E2EE Device Enrollment</h1>
          <p className="text-sm text-muted-foreground">
            Exécute le vrai flux Supabase : begin → possession Ed25519 → complete → approbation par un appareil ready → lecture état → révocation du device synthétique.
          </p>
        </header>

        <section className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={loadDevices}
              disabled={running}
              className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50"
            >
              Charger mes appareils
            </button>
            <button
              type="button"
              onClick={runTest}
              disabled={running || !approverDeviceId}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {running ? 'Test en cours…' : 'Lancer le test complet'}
            </button>
          </div>

          <label className="block space-y-2 text-sm">
            <span>Appareil approbateur local</span>
            <select
              value={approverDeviceId}
              onChange={(event) => setApproverDeviceId(event.target.value)}
              disabled={running}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              <option value="">Aucun appareil local détecté</option>
              {readyDevices.map((device) => (
                <option key={device.device_id} value={device.device_id}>
                  {device.device_name || device.platform || 'Device'} — {device.device_id}
                </option>
              ))}
            </select>
          </label>

          <p className="text-xs text-muted-foreground">
            La page ne peut signer l’approbation qu’avec une clé privée déjà présente localement sur ce navigateur. Le device synthétique est révoqué à la fin du test.
          </p>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-medium">Journal</h2>
          <div className="space-y-3">
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun test lancé.</p>
            ) : logs.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <strong>{entry.step}</strong>
                  <span>{entry.status.toUpperCase()} · {entry.at}</span>
                </div>
                {entry.data !== undefined ? (
                  <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                    {JSON.stringify(entry.data, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
