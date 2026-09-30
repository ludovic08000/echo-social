export type LoginRiskReason = 'UNVERIFIED_DEVICE' | 'COUNTRY_CHANGED';

export interface LoginRiskAssessment {
  status: 'approved' | 'pending';
  riskLevel: 'low' | 'high';
  reasons: LoginRiskReason[];
  countryChanged: boolean;
}

export function assessLoginRisk(args: {
  trustedDeviceProof: boolean;
  previousCountry: string | null;
  currentCountry: string | null;
}): LoginRiskAssessment {
  const previousCountry = args.previousCountry?.trim().toUpperCase() || null;
  const currentCountry = args.currentCountry?.trim().toUpperCase() || null;
  const countryChanged = Boolean(
    previousCountry && currentCountry && previousCountry !== currentCountry,
  );
  const reasons: LoginRiskReason[] = [];
  if (!args.trustedDeviceProof) reasons.push('UNVERIFIED_DEVICE');
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
