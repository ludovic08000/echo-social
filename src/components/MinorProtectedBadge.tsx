import { Shield } from 'lucide-react';

export function MinorProtectedBadge() {
  return (
    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 text-xs font-medium">
      <Shield className="w-3 h-3" />
      Compte protégé
    </div>
  );
}
