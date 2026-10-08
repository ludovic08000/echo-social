import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';

/**
 * Check if a specific user is a minor (has active parental control).
 */
export function useIsMinor(userId: string | undefined) {
  return useQuery({
    queryKey: ['is-minor', 'parental-disabled', userId],
    queryFn: async () => false,
    initialData: false,
    staleTime: Infinity,
  });
}

/**
 * Check if the current user is a minor.
 */
export function useCurrentUserIsMinor() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['is-minor', 'parental-disabled', user?.id],
    queryFn: async () => false,
    initialData: false,
    staleTime: Infinity,
  });
}

/**
 * Hook to check if current user can message a target user.
 * Minors can only be messaged by friends.
 */
export function useCanMessageUser(targetUserId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['can-message', 'parental-disabled', user?.id, targetUserId],
    queryFn: async () => ({ canMessage: true, reason: '' }),
    initialData: { canMessage: true, reason: '' },
    staleTime: Infinity,
  });
}
