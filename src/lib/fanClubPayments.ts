// Règles de paiement du club d'abonnés, isolées des hooks pour être testables sans navigateur.

export const FAN_CLUB_PRICES = [
  { cents: 199, label: '1,99 €' },
  { cents: 299, label: '2,99 €' },
  { cents: 499, label: '4,99 €' },
  { cents: 999, label: '9,99 €' },
  { cents: 1999, label: '19,99 €' },
] as const;

export function formatFanClubPrice(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €/mois`;
}

// Commission ForSure de 25 % sur les abonnements des fans : le créateur garde 75 %.
export const FAN_CLUB_COMMISSION_RATE = 0.25;

export function splitFanClubPayment(amountCents: number): {
  commissionCents: number;
  creatorPayoutCents: number;
} {
  const commissionCents = Math.round(amountCents * FAN_CLUB_COMMISSION_RATE);
  return { commissionCents, creatorPayoutCents: amountCents - commissionCents };
}
