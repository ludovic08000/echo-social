export interface LoginLocationFields {
  countryCode?: string | null;
  region?: string | null;
  city?: string | null;
  timezone?: string | null;
}

function countryLabel(countryCode: string | null | undefined): string | null {
  if (!countryCode || !/^[A-Z]{2}$/i.test(countryCode)) return null;
  try {
    return new Intl.DisplayNames(['fr'], { type: 'region' }).of(countryCode.toUpperCase()) || countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

export function formatLoginLocation(location: LoginLocationFields | null | undefined): string {
  if (!location) return 'Localisation réseau indisponible';
  const precise = [
    location.city,
    location.region,
    countryLabel(location.countryCode),
  ].filter((value): value is string => Boolean(value));
  if (precise.length > 0) return [...new Set(precise)].join(', ');

  if (location.timezone) {
    return `Fuseau ${location.timezone.replace(/_/g, ' ')}`;
  }
  return 'Localisation réseau indisponible';
}
