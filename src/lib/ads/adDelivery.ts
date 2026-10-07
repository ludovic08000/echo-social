export type AdPlacement = 'feed' | 'stories' | 'reels' | 'live' | 'marketplace' | 'sidebar';

export type AdQualityCheck = {
  id: 'headline' | 'body' | 'destination' | 'placement' | 'media' | 'concise';
  label: string;
  passed: boolean;
  required: boolean;
};

export type AdHealth = {
  label: string;
  tone: 'healthy' | 'learning' | 'warning' | 'blocked' | 'neutral';
  detail: string;
};

export const DELIVERABLE_AD_PLACEMENTS: AdPlacement[] = ['feed'];

export function isSafeAdDestination(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function evaluateAdDraft(input: {
  headline: string;
  primaryText: string;
  ctaUrl: string;
  imageUrl: string;
  placements: string[];
}): AdQualityCheck[] {
  const headline = input.headline.trim();
  const primaryText = input.primaryText.trim();

  return [
    {
      id: 'headline',
      label: 'Titre clair (3 caractères minimum)',
      passed: headline.length >= 3,
      required: true,
    },
    {
      id: 'body',
      label: 'Texte principal suffisamment descriptif',
      passed: primaryText.length >= 10,
      required: true,
    },
    {
      id: 'destination',
      label: 'Destination HTTP(S) valide',
      passed: isSafeAdDestination(input.ctaUrl),
      required: true,
    },
    {
      id: 'placement',
      label: 'Au moins un emplacement réellement diffusé',
      passed: input.placements.some((placement) => DELIVERABLE_AD_PLACEMENTS.includes(placement as AdPlacement)),
      required: true,
    },
    {
      id: 'media',
      label: 'Visuel ajouté pour améliorer l’attention',
      passed: Boolean(input.imageUrl.trim()),
      required: false,
    },
    {
      id: 'concise',
      label: 'Texte optimisé pour une lecture mobile',
      passed: primaryText.length > 0 && primaryText.length <= 150,
      required: false,
    },
  ];
}

export function hasRequiredAdQuality(checks: AdQualityCheck[]): boolean {
  return checks.every((check) => !check.required || check.passed);
}

export function getAdHealth(input: {
  campaignStatus: string;
  campaignModerationStatus?: string | null;
  adCount: number;
  activeAdCount: number;
  impressions: number;
  clicks: number;
}): AdHealth {
  if (input.campaignModerationStatus === 'rejected') {
    return { label: 'Bloquée', tone: 'blocked', detail: 'La campagne a été refusée par la modération.' };
  }

  if (input.campaignStatus === 'pending_payment') {
    return { label: 'Paiement requis', tone: 'warning', detail: 'La diffusion commencera après confirmation du paiement.' };
  }

  if (input.campaignStatus === 'active' && (input.adCount === 0 || input.activeAdCount === 0)) {
    return { label: 'À corriger', tone: 'blocked', detail: 'Aucune publicité active ne peut être diffusée.' };
  }

  if (input.campaignStatus === 'active' && input.impressions < 100) {
    return { label: 'Apprentissage', tone: 'learning', detail: 'Pas encore assez de diffusion pour tirer une conclusion.' };
  }

  const ctr = input.impressions > 0 ? (input.clicks / input.impressions) * 100 : 0;
  if (input.campaignStatus === 'active' && input.impressions >= 500 && ctr < 0.5) {
    return { label: 'À optimiser', tone: 'warning', detail: 'Le CTR est faible : teste un nouveau visuel ou message.' };
  }

  if (input.campaignStatus === 'active') {
    return { label: 'Diffusion saine', tone: 'healthy', detail: 'La campagne et ses publicités diffusent normalement.' };
  }

  return { label: 'Inactive', tone: 'neutral', detail: 'La campagne ne diffuse pas actuellement.' };
}

export function getFeedAdCadence(isMobile: boolean): number {
  return isMobile ? 8 : 7;
}

export function getFeedAdSlot(index: number, isMobile: boolean, hasNativeInjection: boolean): number | null {
  const cadence = getFeedAdCadence(isMobile);
  if (hasNativeInjection || index < cadence || index % cadence !== 0) return null;
  return Math.floor(index / cadence) - 1;
}
