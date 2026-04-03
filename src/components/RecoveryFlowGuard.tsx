import { Navigate, useLocation } from 'react-router-dom';
import { detectAndStoreRecoveryFromHash, isRecoveryPending } from '@/lib/authRecovery';

export function RecoveryFlowGuard() {
  const location = useLocation();
  const recoveryPending = isRecoveryPending() || detectAndStoreRecoveryFromHash();

  if (recoveryPending && location.pathname !== '/reset-password') {
    return <Navigate to="/reset-password" replace />;
  }

  return null;
}