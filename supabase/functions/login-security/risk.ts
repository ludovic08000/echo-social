export type LoginRiskReason = 'UNVERIFIED_DEVICE' | 'COUNTRY_CHANGED';

export type LoginSecuritySessionStatus =
  | 'approved'
  | 'pending'
  | 'denied'
  | 'expired'
  | 'unassessed';

export function effectiveLoginSecurityStatus(
  status: unknown,
  expiresAt: unknown,
  nowMs = Date.now(),
): LoginSecuritySessionStatus {
  const normalized = typeof status === 'string'
    && ['approved', 'pending', 'denied', 'expired'].includes(status)
    ? status as Exclude<LoginSecuritySessionStatus, 'unassessed'>
    : 'unassessed';

  if (normalized !== 'approved' && normalized !== 'pending') return normalized;

  const expirationMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  return Number.isFinite(expirationMs) && expirationMs > nowMs
    ? normalized
    : 'expired';
}

export interface LoginRiskAssessment {
  status: 'approved' | 'pending';
  riskLevel: 'low' | 'high';
  reasons: LoginRiskReason[];
  countryChanged: boolean;
}

export interface InitialAccountBootstrapInput {
  accountCreatedAt: string | null;
  emailConfirmedAt: string | null;
  hasPriorLoginSession: boolean;
  hasDeviceHistory: boolean;
  hasAccountIdentity: boolean;
  nowMs?: number;
  maxAgeMs?: number;
}

/**
 * Premier accès uniquement : l'adresse vient d'être confirmée et aucun état
 * Aegis ou de connexion n'existe encore. La fraîcheur porte sur la preuve
 * e-mail, pas sur la création du compte : une personne peut légitimement
 * confirmer plus tard son inscription sans recevoir un second e-mail.
 */
export function isRecentInitialAccountBootstrap(input: InitialAccountBootstrapInput): boolean {
  if (input.hasPriorLoginSession || input.hasDeviceHistory || input.hasAccountIdentity) return false;

  const nowMs = input.nowMs ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? 30 * 60_000;
  const createdAtMs = input.accountCreatedAt ? Date.parse(input.accountCreatedAt) : Number.NaN;
  const confirmedAtMs = input.emailConfirmedAt ? Date.parse(input.emailConfirmedAt) : Number.NaN;
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(confirmedAtMs)) return false;

  return createdAtMs <= nowMs
    && createdAtMs <= confirmedAtMs
    && confirmedAtMs <= nowMs
    && nowMs - confirmedAtMs <= maxAgeMs;
}

export function assessLoginRisk(args: {
  trustedDeviceProof: boolean;
  initialAccountBootstrap?: boolean;
  previousCountry: string | null;
  currentCountry: string | null;
}): LoginRiskAssessment {
  const previousCountry = args.previousCountry?.trim().toUpperCase() || null;
  const currentCountry = args.currentCountry?.trim().toUpperCase() || null;
  const countryChanged = Boolean(
    previousCountry && currentCountry && previousCountry !== currentCountry,
  );
  const reasons: LoginRiskReason[] = [];
  if (!args.trustedDeviceProof && !args.initialAccountBootstrap) reasons.push('UNVERIFIED_DEVICE');
  if (countryChanged) reasons.push('COUNTRY_CHANGED');
  const status = reasons.length === 0 ? 'approved' : 'pending';
  return {
    status,
    riskLevel: status === 'approved' ? 'low' : 'high',
    reasons,
    countryChanged,
  };
}

export function loginDecisionMutation(args: {
  decision: 'approve' | 'deny';
  via: string;
  nowIso: string;
  approvedExpiresAtIso: string;
}): {
  values: Record<string, string | null>;
  revokeAuthSession: boolean;
} {
  if (args.decision === 'approve') {
    return {
      values: {
        status: 'approved',
        approved_at: args.nowIso,
        approved_via: args.via,
        denied_at: null,
        expires_at: args.approvedExpiresAtIso,
        updated_at: args.nowIso,
      },
      revokeAuthSession: false,
    };
  }

  return {
    values: {
      status: 'denied',
      denied_at: args.nowIso,
      approved_via: args.via,
      updated_at: args.nowIso,
    },
    revokeAuthSession: true,
  };
}
