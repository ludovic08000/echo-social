import { useCallback } from 'react';

/**
 * Compatibility hook retained for old imports. Ordinary photos must never
 * trigger an age decision or mutate parental-control state.
 */
export function useAgeVerification() {
  const verifyAge = useCallback(async (_imageUrl: string): Promise<{ flagged: boolean }> => ({ flagged: false }), []);

  return { verifyAge };
}
