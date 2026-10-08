import { useMutation, useQuery } from '@tanstack/react-query';

/** Global, reversible kill switch mirrored by the database migration. */
export const PARENTAL_CONTROLS_ENABLED = false as const;

export const PIN_MIN_LENGTH = 8;
export const PIN_MAX_LENGTH = 12;
export const LEGACY_PIN_MIN_LENGTH = 4;
export const ALLOWED_MINOR_CATEGORIES = ['general', 'education', 'sport', 'gaming', 'musique', 'art', 'humour'] as const;

export interface ParentalControlState {
  id: string;
  user_id: string;
  is_active: boolean;
  is_minor: boolean;
  allowed_categories: string[];
}

export const CATEGORY_LABELS: Record<string, string> = {
  general: '🌐 Général',
  education: '📚 Éducatif',
  sport: '⚽ Sport',
  gaming: '🎮 Gaming',
  musique: '🎵 Musique',
  art: '🎨 Art',
  humour: '😂 Humour',
};

export function useParentalControl() {
  return useQuery<ParentalControlState | null>({
    queryKey: ['parental-control', 'disabled'],
    queryFn: async () => null,
    initialData: null,
    staleTime: Infinity,
  });
}

export function useDisableParentalControl() {
  return useMutation({
    mutationFn: async (_pin: string) => true,
  });
}

export function useSetParentalPin() {
  return useMutation({
    mutationFn: async (_input: { pin: string; currentPin?: string; allowedCategories?: string[] }) => (
      { ok: true, enabled: false, disabled: true }
    ),
  });
}

export function useVerifyParentalPin() {
  return useMutation({
    mutationFn: async (_pin: string): Promise<boolean> => true,
  });
}

export function useIsMinorWithParentalControl() {
  return {
    isMinor: false,
    allowedCategories: [] as string[],
    isLoading: false,
  };
}
