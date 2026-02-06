import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Check, Type, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';

type ThemeMode = 'light' | 'dark' | 'system';

const accentColors = [
  { id: 'bleu', label: 'Bleu Français', hsl: '220 70% 50%', preview: 'bg-[hsl(220,70%,50%)]' },
  { id: 'emerald', label: 'Émeraude', hsl: '160 60% 45%', preview: 'bg-[hsl(160,60%,45%)]' },
  { id: 'violet', label: 'Violet', hsl: '270 60% 55%', preview: 'bg-[hsl(270,60%,55%)]' },
  { id: 'rose', label: 'Rose', hsl: '340 65% 55%', preview: 'bg-[hsl(340,65%,55%)]' },
  { id: 'amber', label: 'Ambre', hsl: '35 80% 50%', preview: 'bg-[hsl(35,80%,50%)]' },
  { id: 'coral', label: 'Corail', hsl: '15 75% 55%', preview: 'bg-[hsl(15,75%,55%)]' },
];

const themeModes: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { id: 'light', label: 'Clair', icon: <Sun className="w-4 h-4" /> },
  { id: 'dark', label: 'Sombre', icon: <Moon className="w-4 h-4" /> },
  { id: 'system', label: 'Système', icon: <Monitor className="w-4 h-4" /> },
];

export function AppearanceSettingsPanel() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem('theme-mode') as ThemeMode) || 'dark';
  });
  const [accentColor, setAccentColor] = useState(() => {
    return localStorage.getItem('accent-color') || 'bleu';
  });
  const [fontSize, setFontSize] = useState(() => {
    return parseInt(localStorage.getItem('font-size') || '16', 10);
  });
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem('compact-mode') === 'true';
  });
  const [animationsEnabled, setAnimationsEnabled] = useState(() => {
    return localStorage.getItem('animations-disabled') !== 'true';
  });

  useEffect(() => {
    const root = document.documentElement;
    
    // Apply theme
    if (themeMode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
      root.classList.toggle('light', !prefersDark);
    } else {
      root.classList.toggle('dark', themeMode === 'dark');
      root.classList.toggle('light', themeMode === 'light');
    }
    localStorage.setItem('theme-mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    const color = accentColors.find(c => c.id === accentColor);
    if (color) {
      document.documentElement.style.setProperty('--primary', color.hsl);
      document.documentElement.style.setProperty('--ring', color.hsl);
    }
    localStorage.setItem('accent-color', accentColor);
  }, [accentColor]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
    localStorage.setItem('font-size', String(fontSize));
  }, [fontSize]);

  useEffect(() => {
    document.documentElement.classList.toggle('compact-mode', compactMode);
    localStorage.setItem('compact-mode', String(compactMode));
  }, [compactMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('no-animations', !animationsEnabled);
    localStorage.setItem('animations-disabled', String(!animationsEnabled));
  }, [animationsEnabled]);

  return (
    <div className="space-y-6">
      {/* Theme Mode */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mode d'affichage</h3>
        <div className="grid grid-cols-3 gap-2">
          {themeModes.map(mode => (
            <button
              key={mode.id}
              onClick={() => setThemeMode(mode.id)}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-200",
                themeMode === mode.id
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-border/30 bg-secondary/20 hover:bg-secondary/40"
              )}
            >
              <div className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                themeMode === mode.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )}>
                {mode.icon}
              </div>
              <span className="text-xs font-medium">{mode.label}</span>
              {themeMode === mode.id && (
                <Check className="w-3.5 h-3.5 text-primary" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Accent Color */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Couleur d'accent</h3>
        <div className="grid grid-cols-3 gap-2">
          {accentColors.map(color => (
            <button
              key={color.id}
              onClick={() => setAccentColor(color.id)}
              className={cn(
                "flex items-center gap-2.5 p-3 rounded-xl border-2 transition-all duration-200",
                accentColor === color.id
                  ? "border-primary bg-primary/5"
                  : "border-border/30 hover:bg-secondary/30"
              )}
            >
              <div className={cn("w-7 h-7 rounded-full shadow-sm flex-shrink-0", color.preview)} />
              <span className="text-xs font-medium truncate">{color.label}</span>
              {accentColor === color.id && (
                <Check className="w-3.5 h-3.5 text-primary ml-auto flex-shrink-0" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Font Size */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Taille du texte</h3>
        <div className="flex items-center gap-3 px-1">
          <button
            onClick={() => setFontSize(Math.max(12, fontSize - 1))}
            className="w-8 h-8 rounded-full bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <div className="flex-1">
            <Slider
              value={[fontSize]}
              onValueChange={([v]) => setFontSize(v)}
              min={12}
              max={22}
              step={1}
              className="w-full"
            />
          </div>
          <button
            onClick={() => setFontSize(Math.min(22, fontSize + 1))}
            className="w-8 h-8 rounded-full bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-muted-foreground w-8 text-center">{fontSize}px</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60 px-1">Aperçu : <span style={{ fontSize: `${fontSize}px` }}>Bonjour le monde !</span></p>
      </div>

      {/* Toggles */}
      <div className="space-y-1">
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Mode compact</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Réduit les espaces pour afficher plus de contenu</p>
          </div>
          <Switch checked={compactMode} onCheckedChange={setCompactMode} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">Animations</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Effets de transition et animations fluides</p>
          </div>
          <Switch checked={animationsEnabled} onCheckedChange={setAnimationsEnabled} />
        </div>
      </div>
    </div>
  );
}
