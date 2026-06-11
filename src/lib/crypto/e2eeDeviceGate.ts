import {
  assessCurrentBrowserDevice,
  type BrowserDeviceInfo,
  type DeviceTrustAssessment,
} from '@/lib/security/browserDeviceTrust';

export type E2EEDeviceGateStatus =
  | 'READY'
  | 'PIN_REQUIRED_FOR_NEW_DEVICE'
  | 'PIN_REQUIRED_FOR_RISK_CHANGE'
  | 'BLOCKED_DEVICE'
  | 'BLOCKED_UNTRUSTED_DEVICE';

export interface E2EEDeviceGateResult {
  ok: boolean;
  status: E2EEDeviceGateStatus;
  assessment: DeviceTrustAssessment;
}

export class E2EEDeviceGateError extends Error {
  readonly status: E2EEDeviceGateStatus;
  readonly assessment: DeviceTrustAssessment;

  constructor(status: E2EEDeviceGateStatus, assessment: DeviceTrustAssessment) {
    super(status);
    this.name = 'E2EEDeviceGateError';
    this.status = status;
    this.assessment = assessment;
  }
}

const TRUST_CACHE_TTL_MS = 20_000;
const trustCache = new Map<string, { expiresAt: number; result: E2EEDeviceGateResult }>();

export function clearE2EEDeviceGateCache(userId?: string) {
  if (!userId) {
    trustCache.clear();
    return;
  }
  trustCache.delete(userId);
}

if (typeof window !== 'undefined') {
  const clearFromEvent = (event: Event) => {
    const userId = (event as CustomEvent<{ userId?: string }>).detail?.userId;
    clearE2EEDeviceGateCache(userId);
  };
  window.addEventListener('forsure:e2ee-device-trust-required', clearFromEvent);
  window.addEventListener('forsure:e2ee-device-trusted', clearFromEvent);
  window.addEventListener('forsure:e2ee-device-revoked', clearFromEvent);
  window.addEventListener('forsure-keys-restored', clearFromEvent);
}

/**
 * Hard gate before E2EE send/sync/fanout/backup.
 *
 * Rules:
 * - unknown browser/device => PIN required;
 * - changed OS/browser/location/timezone => PIN required depending on risk;
 * - revoked/blocked device => blocked;
 * - pending device => no E2EE operation until PIN validation.
 */
export async function assertE2EETrustedBrowserDevice(
  userId: string,
  location?: Pick<BrowserDeviceInfo, 'country' | 'region' | 'city' | 'ipHash'>,
): Promise<E2EEDeviceGateResult> {
  const cached = !location ? trustCache.get(userId) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const assessment = await assessCurrentBrowserDevice(userId, location);

  if (assessment.riskLevel === 'blocked') {
    throw new E2EEDeviceGateError('BLOCKED_DEVICE', assessment);
  }

  if (!assessment.known) {
    throw new E2EEDeviceGateError('PIN_REQUIRED_FOR_NEW_DEVICE', assessment);
  }

  if (assessment.requiresPin) {
    throw new E2EEDeviceGateError('PIN_REQUIRED_FOR_RISK_CHANGE', assessment);
  }

  if (!assessment.trusted) {
    throw new E2EEDeviceGateError('BLOCKED_UNTRUSTED_DEVICE', assessment);
  }

  const result = {
    ok: true,
    status: 'READY',
    assessment,
  };

  if (!location) {
    trustCache.set(userId, {
      expiresAt: Date.now() + TRUST_CACHE_TTL_MS,
      result,
    });
  }

  return result;
}
