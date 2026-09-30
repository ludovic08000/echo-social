import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { bufferToBase64, encodeString } from '@/lib/crypto/utils';
import {
  hydrateDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';

export type LoginSecurityStatus =
  | 'signed_out'
  | 'checking'
  | 'approved'
  | 'pending'
  | 'denied'
  | 'unassessed'
  | 'error';

export interface LoginSecuritySession {
  sessionId?: string;
  status: 'approved' | 'pending' | 'denied' | 'expired' | 'unassessed';
  riskLevel?: 'low' | 'medium' | 'high';
  reasons?: string[];
  knownDevice?: boolean;
  deviceId?: string | null;
  countryCode?: string | null;
  region?: string | null;
  city?: string | null;
  device?: string | null;
  createdAt?: string;
  emailSentAt?: string | null;
  approvedVia?: string | null;
}

export interface LoginSecurityState {
  status: LoginSecurityStatus;
  session: LoginSecuritySession | null;
  errorCode?: string;
}

export interface PendingLoginSecuritySession extends LoginSecuritySession {
  sessionId: string;
  status: 'pending';
}

type ProofIntent = 'assess' | 'approve' | 'deny';
type FunctionPayload = Record<string, unknown>;

async function functionErrorCode(error: unknown): Promise<string> {
  const candidate = error as { context?: Response; message?: string } | null;
  try {
    const data = await candidate?.context?.clone().json() as { code?: unknown } | undefined;
    if (typeof data?.code === 'string') return data.code;
  } catch {
    // The function can fail before returning a JSON body.
  }
  return typeof candidate?.message === 'string' && candidate.message
    ? candidate.message
    : 'LOGIN_SECURITY_REQUEST_FAILED';
}

async function invoke(body: FunctionPayload): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('login-security', { body });
  if (error) throw new Error(await functionErrorCode(error));
  const result = data as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    throw new Error(typeof result?.code === 'string' ? result.code : 'LOGIN_SECURITY_REQUEST_REJECTED');
  }
  return result;
}

function normalizeSession(value: unknown): LoginSecuritySession {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawStatus = typeof row.status === 'string' ? row.status : 'unassessed';
  const status = ['approved', 'pending', 'denied', 'expired', 'unassessed'].includes(rawStatus)
    ? rawStatus as LoginSecuritySession['status']
    : 'unassessed';
  return {
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    status,
    riskLevel: ['low', 'medium', 'high'].includes(String(row.riskLevel))
      ? row.riskLevel as LoginSecuritySession['riskLevel']
      : undefined,
    reasons: Array.isArray(row.reasons)
      ? row.reasons.filter((reason): reason is string => typeof reason === 'string')
      : [],
    knownDevice: row.knownDevice === true,
    deviceId: typeof row.deviceId === 'string' ? row.deviceId : null,
    countryCode: typeof row.countryCode === 'string' ? row.countryCode : null,
    region: typeof row.region === 'string' ? row.region : null,
    city: typeof row.city === 'string' ? row.city : null,
    device: typeof row.device === 'string' ? row.device : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
    emailSentAt: typeof row.emailSentAt === 'string' ? row.emailSentAt : null,
    approvedVia: typeof row.approvedVia === 'string' ? row.approvedVia : null,
  };
}

async function createDeviceProof(
  userId: string,
  intent: ProofIntent,
  targetSessionId?: string,
): Promise<{ challengeId: string; deviceId: string; signature: string } | null> {
  setCurrentDeviceUserScope(userId);
  let deviceId: string;
  try {
    deviceId = await hydrateDeviceId();
  } catch {
    return null;
  }

  const identity = await loadDeviceIdentity(userId, deviceId).catch(() => null);
  if (!identity) return null;

  const challenge = await invoke({
    action: 'challenge',
    intent,
    deviceId,
    targetSessionId,
  });
  const challengeId = typeof challenge.challengeId === 'string' ? challenge.challengeId : '';
  const payload = typeof challenge.payload === 'string' ? challenge.payload : '';
  if (!challengeId || !payload) throw new Error('LOGIN_SECURITY_CHALLENGE_INVALID');

  const signature = bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    identity.privateKey,
    encodeString(payload),
  ) as ArrayBuffer);
  return { challengeId, deviceId, signature };
}

export async function assessCurrentLoginSession(userId: string): Promise<LoginSecuritySession> {
  const proof = await createDeviceProof(userId, 'assess').catch(() => null);
  const result = await invoke({
    action: 'assess',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    ...(proof || {}),
  });
  return normalizeSession(result.session);
}

export async function readCurrentLoginSecuritySession(): Promise<LoginSecuritySession> {
  const result = await invoke({ action: 'status' });
  return normalizeSession(result.session);
}

export async function resendLoginSecurityEmail(): Promise<void> {
  await invoke({ action: 'resend' });
}

export async function listPendingLoginSecuritySessions(): Promise<PendingLoginSecuritySession[]> {
  const result = await invoke({ action: 'list_pending' });
  const rows = Array.isArray(result.sessions) ? result.sessions : [];
  return rows
    .map(normalizeSession)
    .filter((session): session is PendingLoginSecuritySession =>
      session.status === 'pending' && typeof session.sessionId === 'string');
}

export async function decidePendingLoginSecuritySession(
  userId: string,
  targetSessionId: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  const proof = await createDeviceProof(userId, decision, targetSessionId);
  if (!proof) throw new Error('TRUSTED_DEVICE_PROOF_REQUIRED');
  await invoke({
    action: 'decide_pending',
    decision,
    targetSessionId,
    ...proof,
  });
}

/**
 * Safe deployment fallback. While database enforcement is deliberately off,
 * the RPC returns true even if the Edge Function has not reached every region.
 * Once enforcement is enabled it returns true only for an approved session, so
 * this cannot turn a service outage into an authentication bypass.
 */
export async function isLoginSecurityServerGateOpen(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_current_login_session_approved' as never);
  return !error && data === true;
}
