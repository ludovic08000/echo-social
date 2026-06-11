import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  isArchiveBackupEnabled,
  setArchiveBackupEnabled,
  onArchiveBackupChange,
} from '@/lib/messaging/archive/archivePrefs';

export function ArchiveBackupToggle() {
  const [enabled, setEnabled] = useState(() => isArchiveBackupEnabled());

  useEffect(() => onArchiveBackupChange(setEnabled), []);

  const handleChange = (next: boolean) => {
    setEnabled(next);
    setArchiveBackupEnabled(next);
  };

  return (
    <section className="premium-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Archive className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">Sauvegarde chiffrée d&rsquo;historique</h3>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-1">
          <Label htmlFor="archive-backup-toggle" className="text-sm font-medium">
            Activer la sauvegarde
          </Label>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Permet de relire vos messages sur un nouvel appareil après une perte de
            session. Toujours chiffré de bout en bout — le serveur ne peut pas les lire.
            Désactivez pour une confidentialité maximale (forward secrecy stricte).
          </p>
        </div>
        <Switch
          id="archive-backup-toggle"
          checked={enabled}
          onCheckedChange={handleChange}
        />
      </div>
    </section>
  );
}
