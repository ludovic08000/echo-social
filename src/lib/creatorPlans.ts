export type CreatorPlanId = 'creator_essential' | 'creator_pro' | 'creator_studio';

export const CREATOR_PLANS = [
  { id: 'creator_essential', name: 'Essentiel', price: '4,99 €', features: ['Lives jusqu’à 60 min', 'Publicités créateur', 'Badge créateur'] },
  { id: 'creator_pro', name: 'Pro', price: '9,99 €', features: ['Lives prolongés et HD', 'Replays', 'Statistiques avancées', 'Publicités créateur'] },
  { id: 'creator_studio', name: 'Studio', price: '19,99 €', features: ['Qualité et capacité maximales', 'Outils marketing avancés', 'Replays et statistiques', 'Publicités créateur'] },
] as const;

export const CREATOR_PLAN_IDS = CREATOR_PLANS.map((plan) => plan.id);

export function isCreatorPlan(value: unknown): value is CreatorPlanId {
  return typeof value === 'string' && CREATOR_PLAN_IDS.includes(value as CreatorPlanId);
}
