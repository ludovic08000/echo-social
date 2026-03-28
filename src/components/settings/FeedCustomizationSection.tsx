import { Check, Type, Palette, PaintBucket } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useFeedCustomization,
  FONT_OPTIONS,
  TEXT_COLOR_OPTIONS,
  BG_COLOR_OPTIONS,
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
          {FONT_OPTIONS.map(font => (
            <button
              key={font.id}
              onClick={() => update({ fontFamily: font.id })}
              className={cn(
                "p-3 rounded-xl border-2 transition-all text-left",
                prefs.fontFamily === font.id
                  ? "border-primary bg-primary/10"
                  : "border-border/30 hover:bg-secondary/30"
              )}
            >
              <span
                className="text-sm font-medium block truncate"
                style={{ fontFamily: font.css }}
              >
                {font.label}
              </span>
              <span
                className="text-[10px] text-muted-foreground mt-1 block"
                style={{ fontFamily: font.css }}
              >
                Aa Bb Cc 123
              </span>
              {prefs.fontFamily === font.id && (
                <Check className="w-3 h-3 text-primary mt-1" />
              )}
            </button>
          ))}
        </div>
      </div>

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
