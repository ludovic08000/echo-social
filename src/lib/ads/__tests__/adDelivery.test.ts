import { describe, expect, it } from 'vitest';
import {
  evaluateAdDraft,
  getAdHealth,
  getFeedAdSlot,
  hasRequiredAdQuality,
  isSafeAdDestination,
} from '@/lib/ads/adDelivery';

describe('ad delivery safeguards', () => {
  it('only accepts empty or HTTP(S) destinations', () => {
    expect(isSafeAdDestination('')).toBe(true);
    expect(isSafeAdDestination('https://forsure.fans/offre')).toBe(true);
    expect(isSafeAdDestination('http://example.test')).toBe(true);
    expect(isSafeAdDestination('javascript:alert(1)')).toBe(false);
    expect(isSafeAdDestination('pas une url')).toBe(false);
  });

  it('blocks checkout when a required creative check fails', () => {
    const invalid = evaluateAdDraft({
      headline: 'Ok',
      primaryText: 'Trop court',
      ctaUrl: 'javascript:alert(1)',
      imageUrl: '',
      placements: ['stories'],
    });
    const valid = evaluateAdDraft({
      headline: 'Découvre ForSure',
      primaryText: 'Une campagne claire et lisible sur mobile.',
      ctaUrl: 'https://forsure.fans',
      imageUrl: '',
      placements: ['feed'],
    });

    expect(hasRequiredAdQuality(invalid)).toBe(false);
    expect(hasRequiredAdQuality(valid)).toBe(true);
  });

  it('inserts mobile and desktop ads without replacing native feed modules', () => {
    expect(getFeedAdSlot(7, false, false)).toBe(0);
    expect(getFeedAdSlot(8, true, false)).toBe(0);
    expect(getFeedAdSlot(8, true, true)).toBeNull();
    expect(getFeedAdSlot(6, false, false)).toBeNull();
  });

  it('reports campaign health from actionable signals', () => {
    expect(getAdHealth({
      campaignStatus: 'active',
      adCount: 1,
      activeAdCount: 0,
      impressions: 0,
      clicks: 0,
    }).tone).toBe('blocked');

    expect(getAdHealth({
      campaignStatus: 'active',
      adCount: 1,
      activeAdCount: 1,
      impressions: 1_000,
      clicks: 2,
    }).label).toBe('À optimiser');

    expect(getAdHealth({
      campaignStatus: 'active',
      adCount: 1,
      activeAdCount: 1,
      impressions: 1_000,
      clicks: 30,
    }).tone).toBe('healthy');
  });
});
