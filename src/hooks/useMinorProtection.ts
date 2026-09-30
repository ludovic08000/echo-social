import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

/**
 * Check if a specific user is a minor (has active parental control).
 */
export function useIsMinor(userId: string | undefined) {
  return useQuery({
    queryKey: ['is-minor', userId],
    queryFn: async () => {
      if (!userId) return false;
      const { data, error } = await supabase.rpc('is_user_protected_minor' as any, {
        p_user_id: userId,
      } as any);
      if (error) return false;
      return data === true;
    },
    enabled: !!userId,
    staleTime: 5 * 60_000,
  });
}

/**
 * Check if the current user is a minor.
 */
export function useCurrentUserIsMinor() {
  const { user, loading } = useAuth();

  return useQuery({
    queryKey: ['is-minor', user?.id, loading ? 'loading' : 'ready'],
    queryFn: async () => {
      if (!user?.id) return false;

      const { data, error } = await supabase.rpc('is_user_protected_minor' as any, {
        p_user_id: user.id,
      } as any);
      if (error) return false;
      return data === true;
    },
    enabled: !!user?.id && !loading,
    staleTime: 5 * 60_000,
  });
}

/**
 * Hook to check if current user can message a target user.
 * Minors can only be messaged by friends.
 */
export function useCanMessageUser(targetUserId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['can-message', user?.id, targetUserId],
    queryFn: async () => {
      if (!user || !targetUserId || user.id === targetUserId) return { canMessage: true, reason: '' };

      // Check if target is a minor
      const { data: targetIsMinor, error: minorError } = await supabase.rpc('is_user_protected_minor' as any, {
        p_user_id: targetUserId,
      } as any);
      if (minorError || targetIsMinor !== true) return { canMessage: true, reason: '' };

      // Target is a minor - check friendship
      const { data: friendship } = await supabase
        .from('friendships')
        .select('id')
        .or(`and(requester_id.eq.${user.id},addressee_id.eq.${targetUserId}),and(requester_id.eq.${targetUserId},addressee_id.eq.${user.id})`)
        .eq('status', 'accepted')
        .maybeSingle();

      if (friendship) return { canMessage: true, reason: '' };

      return {
        canMessage: false,
        reason: 'Ce compte est protégé. Seuls les amis approuvés peuvent envoyer des messages.',
      };
    },
    enabled: !!user && !!targetUserId,
    staleTime: 60_000,
  });
}
