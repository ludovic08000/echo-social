export const MARKETPLACE_CATEGORIES = [
  { value: 'fashion', label: 'Mode', icon: '👗' },
  { value: 'electronics', label: 'Tech', icon: '📱' },
  { value: 'phones', label: 'Téléphonie', icon: '📞' },
  { value: 'art', label: 'Art & Créations', icon: '🎨' },
  { value: 'beauty', label: 'Beauté', icon: '💄' },
  { value: 'home', label: 'Maison', icon: '🏠' },
  { value: 'sports', label: 'Sport', icon: '⚽' },
  { value: 'books', label: 'Livres', icon: '📚' },
  { value: 'general', label: 'Autre', icon: '📦' },
] as const;

export const BROWSE_CATEGORIES = [
  { value: 'all', label: 'Tout', icon: '🔥' },
  ...MARKETPLACE_CATEGORIES,
] as const;

export const CATEGORY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  MARKETPLACE_CATEGORIES.map((c) => [c.value, c.label])
);
