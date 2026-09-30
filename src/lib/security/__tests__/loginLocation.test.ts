import { describe, expect, it } from 'vitest';
import { formatLoginLocation } from '../loginLocation';

describe('login location display', () => {
  it('uses enriched network location when available', () => {
    expect(formatLoginLocation({
      city: 'Paris',
      region: 'Île-de-France',
      countryCode: 'FR',
      timezone: 'Europe/Paris',
    })).toBe('Paris, Île-de-France, France');
  });

  it('shows the browser timezone as an honest fallback', () => {
    expect(formatLoginLocation({ timezone: 'Europe/Paris' })).toBe('Fuseau Europe/Paris');
    expect(formatLoginLocation(null)).toBe('Localisation réseau indisponible');
  });
});
