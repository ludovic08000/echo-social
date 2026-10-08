/**
 * Contrat de mélange des médias éditoriaux dans le feed social.
 *
 * Le poids vient d'un choix explicite de l'utilisateur. Il ne dépend ni du
 * temps d'écran, ni des messages privés, ni d'un objectif d'engagement caché.
 */
export interface EditorialBlendPlan {
  enabled: boolean;
  firstPostIndex: number;
  cadence: number;
  maxItems: number;
}

function boundedWeight(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.max(0, Math.min(100, Math.round(value as number)));
}

export function buildEditorialBlendPlan(newsWeight: number | null | undefined): EditorialBlendPlan {
  const weight = boundedWeight(newsWeight);
  if (weight === 0) {
    return { enabled: false, firstPostIndex: 0, cadence: Number.POSITIVE_INFINITY, maxItems: 0 };
  }

  if (weight >= 85) return { enabled: true, firstPostIndex: 0, cadence: 3, maxItems: 8 };
  if (weight >= 65) return { enabled: true, firstPostIndex: 1, cadence: 4, maxItems: 6 };
  if (weight >= 45) return { enabled: true, firstPostIndex: 1, cadence: 5, maxItems: 5 };
  if (weight >= 25) return { enabled: true, firstPostIndex: 2, cadence: 7, maxItems: 4 };
  return { enabled: true, firstPostIndex: 3, cadence: 10, maxItems: 2 };
}

export function editorialMediaSlotAfterPost(
  postIndex: number,
  plan: EditorialBlendPlan,
): number | null {
  if (!plan.enabled || postIndex < plan.firstPostIndex) return null;
  const distance = postIndex - plan.firstPostIndex;
  if (distance % plan.cadence !== 0) return null;
  const slot = Math.floor(distance / plan.cadence);
  return slot < plan.maxItems ? slot : null;
}
