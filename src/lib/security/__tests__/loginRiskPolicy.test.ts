import { describe, expect, it } from 'vitest';
import {
  assessLoginRisk,
  effectiveLoginSecurityStatus,
  loginDecisionMutation,
} from '../../../../supabase/functions/login-security/risk';

describe('login-security risk policy', () => {
  it('approves a trusted device in the habitual country', () => {
    expect(assessLoginRisk({
      trustedDeviceProof: true,
      previousCountry: 'FR',
      currentCountry: 'FR',
    })).toEqual({
      status: 'approved',
      riskLevel: 'low',
      reasons: [],
      countryChanged: false,
    });
  });

  it('allows a trusted device to establish the first country baseline', () => {
    expect(assessLoginRisk({
      trustedDeviceProof: true,
      previousCountry: null,
      currentCountry: 'FR',
    }).status).toBe('approved');
  });

  it.each([
    ['travel from France to the United States', 'US'],
    ['a country-changing VPN exit', 'NL'],
  ])('requires approval for %s', (_label, currentCountry) => {
    expect(assessLoginRisk({
      trustedDeviceProof: true,
      previousCountry: 'FR',
      currentCountry,
    })).toMatchObject({
      status: 'pending',
      riskLevel: 'high',
      reasons: ['COUNTRY_CHANGED'],
      countryChanged: true,
    });
  });

  it('requires approval for a new browser even in France', () => {
    expect(assessLoginRisk({
      trustedDeviceProof: false,
      previousCountry: 'FR',
      currentCountry: 'FR',
    })).toMatchObject({
      status: 'pending',
      reasons: ['UNVERIFIED_DEVICE'],
    });
  });

  it('accumulates independent device and country reasons', () => {
    expect(assessLoginRisk({
      trustedDeviceProof: false,
      previousCountry: 'FR',
      currentCountry: 'US',
    }).reasons).toEqual(['UNVERIFIED_DEVICE', 'COUNTRY_CHANGED']);
  });

  it('approves explicitly without revoking the auth session', () => {
    const mutation = loginDecisionMutation({
      decision: 'approve',
      via: 'email',
      nowIso: '2026-09-30T00:00:00.000Z',
      approvedExpiresAtIso: '2026-10-30T00:00:00.000Z',
    });
    expect(mutation.values.status).toBe('approved');
    expect(mutation.revokeAuthSession).toBe(false);
  });

  it('denies and requires exact auth-session revocation', () => {
    const mutation = loginDecisionMutation({
      decision: 'deny',
      via: 'trusted_device',
      nowIso: '2026-09-30T00:00:00.000Z',
      approvedExpiresAtIso: '2026-10-30T00:00:00.000Z',
    });
    expect(mutation.values.status).toBe('denied');
    expect(mutation.revokeAuthSession).toBe(true);
  });

  it('exposes expired pending sessions so the client can reassess and send a fresh email', () => {
    const now = Date.parse('2026-09-30T11:00:00.000Z');

    expect(effectiveLoginSecurityStatus(
      'pending',
      '2026-09-30T10:59:59.999Z',
      now,
    )).toBe('expired');
    expect(effectiveLoginSecurityStatus(
      'pending',
      '2026-09-30T11:15:00.000Z',
      now,
    )).toBe('pending');
  });

  it('fails closed when an approved session is expired or has no valid expiry', () => {
    const now = Date.parse('2026-09-30T11:00:00.000Z');

    expect(effectiveLoginSecurityStatus(
      'approved',
      '2026-09-30T10:59:59.999Z',
      now,
    )).toBe('expired');
    expect(effectiveLoginSecurityStatus('approved', null, now)).toBe('expired');
    expect(effectiveLoginSecurityStatus('denied', null, now)).toBe('denied');
  });
});
