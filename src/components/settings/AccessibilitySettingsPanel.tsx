import { useState, useEffect } from 'react';
import { Accessibility, Volume2, Contrast, MousePointer, Keyboard, Languages } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface AccessibilityPrefs {
  reducedMotion: boolean;
  highContrast: boolean;
  screenReaderOptimized: boolean;
  largeClickTargets: boolean;
  keyboardNavigation: boolean;
  autoplayVideos: boolean;
  captionsEnabled: boolean;
  colorBlindMode: string; // 'none' | 'deuteranopia' | 'protanopia' | 'tritanopia'
  language: string;
  lineSpacing: number; // 1.0 - 2.0
}

const defaultPrefs: AccessibilityPrefs = {
  reducedMotion: false,
  highContrast: false,
  screenReaderOptimized: false,
  largeClickTargets: false,
  keyboardNavigation: false,
  autoplayVideos: true,
  captionsEnabled: false,
  colorBlindMode: 'none',
  language: 'fr',
  lineSpacing: 1.5,
};

const colorBlindOptions = [
  { value: 'none', label: 'Aucun' },
  { value: 'deuteranopia', label: 'Deutéranopie (vert)' },
  { value: 'protanopia', label: 'Protanopie (rouge)' },
  { value: 'tritanopia', label: 'Tritanopie (bleu)' },
];

const languageOptions = [
  { value: 'fr', label: '🇫🇷 Français' },
  { value: 'en', label: '🇬🇧 English' },
  { value: 'es', label: '🇪🇸 Español' },
  { value: 'de', label: '🇩🇪 Deutsch' },
  { value: 'ar', label: '🇸🇦 العربية' },
  { value: 'zh', label: '🇨🇳 中文' },
];

const shortcuts = [
  { keys: ['N'], desc: 'Nouvelle publication' },
  { keys: ['/', 'S'], desc: 'Rechercher' },
  { keys: ['G', 'H'], desc: 'Aller au fil' },
  { keys: ['G', 'P'], desc: 'Aller au profil' },
  { keys: ['G', 'M'], desc: 'Messages' },
  { keys: ['G', 'N'], desc: 'Notifications' },
  { keys: ['J'], desc: 'Publication suivante' },
  { keys: ['K'], desc: 'Publication précédente' },
  { keys: ['L'], desc: 'Liker / Retirer le like' },
  { keys: ['C'], desc: 'Commenter' },
  { keys: ['Esc'], desc: 'Fermer / Annuler' },
];

export function AccessibilitySettingsPanel() {
  const [prefs, setPrefs] = useState<AccessibilityPrefs>(() => {
    try {
      const saved = localStorage.getItem('accessibility-prefs');
      return saved ? { ...defaultPrefs, ...JSON.parse(saved) } : defaultPrefs;
    } catch {
      return defaultPrefs;
    }
  });

  useEffect(() => {
    localStorage.setItem('accessibility-prefs', JSON.stringify(prefs));

    const root = document.documentElement;
    root.classList.toggle('reduced-motion', prefs.reducedMotion);
    root.classList.toggle('high-contrast', prefs.highContrast);
    root.classList.toggle('large-targets', prefs.largeClickTargets);
    root.style.setProperty('--line-height-factor', String(prefs.lineSpacing));
  }, [prefs]);

  const update = (patch: Partial<AccessibilityPrefs>) => {
    setPrefs(prev => ({ ...prev, ...patch }));
  };

  return (
    <div className="space-y-6">
      {/* Language */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Languages className="w-3.5 h-3.5" />
          Langue de l'interface
        </h3>
        <Select value={prefs.language} onValueChange={v => update({ language: v })}>
          <SelectTrigger className="rounded-xl h-10 bg-secondary/40 border-border/30">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map(lang => (
              <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Visual */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <Contrast className="w-3.5 h-3.5" />
          Affichage
        </h3>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Contraste élevé</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Améliore la lisibilité du texte</p>
          </div>
          <Switch checked={prefs.highContrast} onCheckedChange={v => update({ highContrast: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Mouvement réduit</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Limite les animations et transitions</p>
          </div>
          <Switch checked={prefs.reducedMotion} onCheckedChange={v => update({ reducedMotion: v })} />
        </div>

        <div className="space-y-2 p-3">
          <Label className="text-sm font-medium">Daltonisme</Label>
          <Select value={prefs.colorBlindMode} onValueChange={v => update({ colorBlindMode: v })}>
            <SelectTrigger className="rounded-xl h-9 text-sm bg-secondary/40 border-border/30">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {colorBlindOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 p-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Interligne</Label>
            <span className="text-xs text-muted-foreground">{prefs.lineSpacing.toFixed(1)}</span>
          </div>
          <Slider
            value={[prefs.lineSpacing * 10]}
            onValueChange={([v]) => update({ lineSpacing: v / 10 })}
            min={10}
            max={25}
            step={1}
          />
        </div>
      </div>

      {/* Interaction */}
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <MousePointer className="w-3.5 h-3.5" />
          Interaction
        </h3>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Zones de clic agrandies</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Boutons et liens plus faciles à cibler</p>
          </div>
          <Switch checked={prefs.largeClickTargets} onCheckedChange={v => update({ largeClickTargets: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Lecture auto des vidéos</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Les vidéos se lancent automatiquement</p>
          </div>
          <Switch checked={prefs.autoplayVideos} onCheckedChange={v => update({ autoplayVideos: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Sous-titres automatiques</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Activer les sous-titres sur les vidéos</p>
          </div>
          <Switch checked={prefs.captionsEnabled} onCheckedChange={v => update({ captionsEnabled: v })} />
        </div>

        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Optimisé lecteur d'écran</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Améliore la compatibilité ARIA</p>
          </div>
          <Switch checked={prefs.screenReaderOptimized} onCheckedChange={v => update({ screenReaderOptimized: v })} />
        </div>
      </div>

      {/* Keyboard Shortcuts */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Keyboard className="w-3.5 h-3.5" />
            Raccourcis clavier
          </h3>
          <Switch checked={prefs.keyboardNavigation} onCheckedChange={v => update({ keyboardNavigation: v })} />
        </div>

        {prefs.keyboardNavigation && (
          <div className="rounded-xl border border-border/30 overflow-hidden">
            {shortcuts.map((shortcut, i) => (
              <div
                key={shortcut.desc}
                className={cn(
                  "flex items-center justify-between px-4 py-2.5 text-xs",
                  i < shortcuts.length - 1 && "border-b border-border/20"
                )}
              >
                <span className="text-muted-foreground">{shortcut.desc}</span>
                <div className="flex gap-1">
                  {shortcut.keys.map((key, j) => (
                    <span key={j}>
                      <kbd className="px-2 py-0.5 rounded-md bg-secondary/60 border border-border/30 text-[10px] font-mono font-semibold">
                        {key}
                      </kbd>
                      {j < shortcut.keys.length - 1 && (
                        <span className="text-muted-foreground/50 mx-0.5">+</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
