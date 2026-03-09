import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Hook that triggers age verification on the user's first photo upload.
 * Calls the age-verify edge function which uses AI vision to estimate age.
 * If a minor is detected (declared 16+ but looks <18), the account is flagged.
 */
export function useAgeVerification() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const verifyAge = useCallback(async (imageUrl: string): Promise<{ flagged: boolean }> => {
    if (!user) return { flagged: false };

    try {
      const { data, error } = await supabase.functions.invoke('age-verify', {
        body: { imageUrl },
      });

      if (error) {
        console.warn('Age verification failed:', error);
        return { flagged: false };
      }

      if (data?.flagged) {
        // Invalidate profile to reflect the new status
        queryClient.invalidateQueries({ queryKey: ['profile', user.id] });

        toast({
          title: '🔒 Vérification d\'identité requise',
          description: 'Notre système a détecté une incohérence avec votre âge déclaré. Veuillez fournir une pièce d\'identité dans les 72h via vos paramètres.',
          variant: 'destructive',
          duration: 10000,
        });

        return { flagged: true };
      }

      return { flagged: false };
    } catch (err) {
      console.warn('Age verification error:', err);
      return { flagged: false };
    }
  }, [user, queryClient]);

  return { verifyAge };
}
