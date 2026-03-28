import { Check, Palette, PaintBucket } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useFeedCustomization,
  TEXT_COLOR_OPTIONS,
  BG_COLOR_OPTIONS,
} from '@/hooks/useFeedCustomization';

export function FeedCustomizationSection() {
  const { prefs, update } = useFeedCustomization();

  return (
    <div className="space-y-5">
      {/* Text color */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Palette className="w-3.5 h-3.5" />
          Couleur du texte
        </h3>
        <div className="flex flex-wrap gap-2">
          {TEXT_COLOR_OPTIONS.map(c => (
            <button
              key={c.id || 'default'}
              onClick={() => update({ textColor: c.id })}
              title={c.label}
              className={cn(
                "w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center",
                prefs.textColor === c.id
                  ? "border-primary ring-2 ring-primary/30 scale-110"
                  : "border-border/40 hover:scale-105"
              )}
            >
              <div className={cn("w-6 h-6 rounded-full", c.preview)} />
            </button>
          ))}
        </div>
        {prefs.textColor && (
          <div className="p-3 rounded-xl bg-secondary/20">
            <p className="text-sm" style={{ color: prefs.textColor }}>
              Aperçu : Voici à quoi ressemblera votre texte ✨
            </p>
          </div>
        )}
      </div>

      {/* Background color */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <PaintBucket className="w-3.5 h-3.5" />
          Fond du feed
        </h3>
        <div className="flex flex-wrap gap-2">
          {BG_COLOR_OPTIONS.map(c => (
            <button
              key={c.id || 'default'}
              onClick={() => update({ bgColor: c.id })}
              title={c.label}
              className={cn(
                "w-9 h-9 rounded-full border-2 transition-all flex items-center justify-center",
                prefs.bgColor === c.id
                  ? "border-primary ring-2 ring-primary/30 scale-110"
                  : "border-border/40 hover:scale-105"
              )}
            >
              <div className={cn("w-6 h-6 rounded-full", c.preview)} />
            </button>
          ))}
        </div>
        {prefs.bgColor && (
          <div
            className="p-3 rounded-xl border border-border/20"
            style={{ backgroundColor: prefs.bgColor }}
          >
            <p className="text-xs text-center" style={{ color: prefs.textColor || undefined }}>
              Aperçu du fond sélectionné
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
