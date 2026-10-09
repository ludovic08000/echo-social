import { describe, expect, it } from 'vitest';
import {
  FAN_CLUB_COMMISSION_RATE,
  formatFanClubPrice,
  splitFanClubPayment,
} from '@/lib/fanClubPayments';

describe('règle de commission des abonnements des fans', () => {
  it('ForSure garde 25 % et le créateur 75 %', () => {
    expect(FAN_CLUB_COMMISSION_RATE).toBe(0.25);
    expect(splitFanClubPayment(299)).toEqual({ commissionCents: 75, creatorPayoutCents: 224 });
    expect(splitFanClubPayment(199)).toEqual({ commissionCents: 50, creatorPayoutCents: 149 });
    expect(splitFanClubPayment(499)).toEqual({ commissionCents: 125, creatorPayoutCents: 374 });
  });

  it('affiche le prix en euros à la française', () => {
    expect(formatFanClubPrice(299)).toBe('2,99 €/mois');
    expect(formatFanClubPrice(1999)).toBe('19,99 €/mois');
  });
});
