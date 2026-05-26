import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { startPostRestoreLifecycle } from '@/lib/crypto/postRestoreLifecycle';

export function usePostRestoreLifecycle() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;
    const handle = startPostRestoreLifecycle(user.id);
    return () => handle.stop();
  }, [user?.id]);
}
