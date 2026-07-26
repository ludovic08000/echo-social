import { Palette, Type, PaintBucket } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useFeedCustomization,
  TEXT_COLOR_OPTIONS,
  BG_COLOR_OPTIONS,
  FONT_OPTIONS,
} from '@/hooks/useFeedCustomization';

export function FeedCustomizationSection() {
  const { prefs, update } = useFeedCustomization();

  return (
    <div className="space-y-5">
      {/* Font family */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Type className="w-3.5 h-3.5" />
          Police du feed
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {FONT_OPTIONS.map(f => (
            <button
              key={f.id}
              onClick={() => update({ fontFamily: f.id })}
              style={{ fontFamily: f.css === 'inherit' ? undefined : f.css }}
              className={cn(
                "p-3 rounded-xl border-2 text-sm transition-all text-left truncate",
                prefs.fontFamily === f.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-secondary/40 hover:bg-secondary/60"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Text color */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Palette className="w-3.5 h-3.5" />
          Couleur du texte du feed
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
      </div>

      {/* Background color */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <PaintBucket className="w-3.5 h-3.5" />
          Couleur de fond du feed
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
      </div>

      {/* Preview */}
      <div
        className="p-3 rounded-xl border border-border/40"
        style={{
          color: prefs.textColor || undefined,
          backgroundColor: prefs.bgColor || undefined,
          fontFamily:
            FONT_OPTIONS.find(f => f.id === prefs.fontFamily)?.css === 'inherit'
              ? undefined
              : FONT_OPTIONS.find(f => f.id === prefs.fontFamily)?.css,
        }}
      >
        <p className="text-sm">Aperçu : Voici à quoi ressemblera votre feed ✨</p>
      </div>
    </div>
  );
}
