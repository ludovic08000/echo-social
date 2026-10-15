export type LoginRiskReason =
  | 'UNVERIFIED_DEVICE'
  | 'COUNTRY_CHANGED'
  | 'RAPID_COUNTRY_CHANGE'
  | 'REGION_CHANGED'
  | 'CITY_CHANGED'
  | 'BROWSER_CHANGED'
  | 'REPEATED_RECENT_ATTEMPTS';

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
  riskLevel: 'low' | 'medium' | 'high';
  riskScore: number;
  reasons: LoginRiskReason[];
  countryChanged: boolean;
}

export interface InitialAccountBootstrapInput {
  accountCreatedAt: string | null;
  emailConfirmedAt: string | null;
  hasPriorLoginSession: boolean;
  nowMs?: number;
  maxAgeMs?: number;
}

/**
 * Premier accès uniquement : l'adresse vient d'être confirmée et aucun état
 * de connexion n'existe encore. Les clés et la ligne du premier appareil
 * peuvent déjà avoir été créées par l'initialisation Aegis avant cette
 * évaluation : elles ne doivent donc jamais disqualifier le premier accès.
 * La fraîcheur porte sur la preuve e-mail, pas sur la création du compte :
 * une personne peut légitimement confirmer plus tard son inscription sans
 * recevoir un second e-mail.
 */
export function isRecentInitialAccountBootstrap(input: InitialAccountBootstrapInput): boolean {
  if (input.hasPriorLoginSession) return false;

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
  previousRegion?: string | null;
  currentRegion?: string | null;
  previousCity?: string | null;
  currentCity?: string | null;
  previousBrowser?: string | null;
  currentBrowser?: string | null;
  previousApprovedAt?: string | null;
  recentSuspiciousAttempts?: number;
  nowMs?: number;
}): LoginRiskAssessment {
  const normalize = (value: string | null | undefined) => value?.trim().toLocaleLowerCase('en') || null;
  const previousCountry = args.previousCountry?.trim().toUpperCase() || null;
  const currentCountry = args.currentCountry?.trim().toUpperCase() || null;
  const countryChanged = Boolean(
    previousCountry && currentCountry && previousCountry !== currentCountry,
  );
  const regionChanged = Boolean(
    !countryChanged && normalize(args.previousRegion) && normalize(args.currentRegion)
      && normalize(args.previousRegion) !== normalize(args.currentRegion),
  );
  const cityChanged = Boolean(
    !countryChanged && !regionChanged && normalize(args.previousCity) && normalize(args.currentCity)
      && normalize(args.previousCity) !== normalize(args.currentCity),
  );
  const browserChanged = Boolean(
    normalize(args.previousBrowser) && normalize(args.currentBrowser)
      && normalize(args.previousBrowser) !== normalize(args.currentBrowser),
  );
  const nowMs = args.nowMs ?? Date.now();
  const previousApprovedMs = args.previousApprovedAt ? Date.parse(args.previousApprovedAt) : Number.NaN;
  const rapidCountryChange = countryChanged && Number.isFinite(previousApprovedMs)
    && nowMs - previousApprovedMs >= 0
    && nowMs - previousApprovedMs <= 6 * 60 * 60_000;
  const reasons: LoginRiskReason[] = [];
  let riskScore = 0;
  const add = (reason: LoginRiskReason, score: number) => {
    reasons.push(reason);
    riskScore += score;
  };
  if (!args.trustedDeviceProof && !args.initialAccountBootstrap) add('UNVERIFIED_DEVICE', 70);
  if (countryChanged) add('COUNTRY_CHANGED', 60);
  if (rapidCountryChange) add('RAPID_COUNTRY_CHANGE', 20);
  if (regionChanged) add('REGION_CHANGED', 15);
  if (cityChanged) add('CITY_CHANGED', 5);
  if (browserChanged) add('BROWSER_CHANGED', 20);
  if ((args.recentSuspiciousAttempts || 0) >= 2) add('REPEATED_RECENT_ATTEMPTS', 25);
  riskScore = Math.min(100, riskScore);
  const status = riskScore >= 50 ? 'pending' : 'approved';
  return {
    status,
    riskLevel: status === 'pending' ? 'high' : riskScore > 0 ? 'medium' : 'low',
    riskScore,
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
