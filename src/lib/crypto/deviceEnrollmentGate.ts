export type ExplicitDeviceEnrollmentReason =
  | 'first_device'
  | 'local_key_lost'
  | 'user_requested_new_device';

type Grant = Readonly<{
  reason: ExplicitDeviceEnrollmentReason;
  expiresAt: number;
}>;

const GRANT_TTL_MS = 60_000;
let grant: Grant | null = null;

export function authorizeExplicitDeviceEnrollment(reason: ExplicitDeviceEnrollmentReason): void {
  grant = { reason, expiresAt: Date.now() + GRANT_TTL_MS };
}

export function consumeExplicitDeviceEnrollmentAuthorization(): ExplicitDeviceEnrollmentReason {
  const current = grant;
  grant = null;
  if (!current || current.expiresAt <= Date.now()) {
    throw new Error('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  }
  return current.reason;
}

export function cancelExplicitDeviceEnrollmentAuthorization(): void {
  grant = null;
}

export function hasExplicitDeviceEnrollmentAuthorization(now = Date.now()): boolean {
  return grant !== null && grant.expiresAt > now;
}

export const __test__ = {
  grantTtlMs: GRANT_TTL_MS,
  reset: cancelExplicitDeviceEnrollmentAuthorization,
};
