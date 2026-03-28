import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Check, Minus, Plus, Zap, Waves } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/lib/i18n';
import { BackgroundSettingsSection } from './BackgroundSettingsSection';
import { useUXMode } from '@/hooks/useUXMode';

type ThemeMode = 'light' | 'dark' | 'system';

const accentColors = [
  { id: 'bleu', labelKey: 'appearance.colorBlue', fallback: 'Bleu Français', hsl: '220 70% 50%', preview: 'bg-[hsl(220,70%,50%)]' },
  { id: 'emerald', labelKey: 'appearance.colorEmerald', fallback: 'Émeraude', hsl: '160 60% 45%', preview: 'bg-[hsl(160,60%,45%)]' },
  { id: 'violet', labelKey: 'appearance.colorViolet', fallback: 'Violet', hsl: '270 60% 55%', preview: 'bg-[hsl(270,60%,55%)]' },
  { id: 'rose', labelKey: 'appearance.colorRose', fallback: 'Rose', hsl: '340 65% 55%', preview: 'bg-[hsl(340,65%,55%)]' },
  { id: 'amber', labelKey: 'appearance.colorAmber', fallback: 'Ambre', hsl: '35 80% 50%', preview: 'bg-[hsl(35,80%,50%)]' },
  { id: 'coral', labelKey: 'appearance.colorCoral', fallback: 'Corail', hsl: '15 75% 55%', preview: 'bg-[hsl(15,75%,55%)]' },
];

export function AppearanceSettingsPanel() {
  const { t } = useTranslation();

  const themeModes: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { id: 'light', label: t('appearance.light'), icon: <Sun className="w-4 h-4" /> },
    { id: 'dark', label: t('appearance.dark'), icon: <Moon className="w-4 h-4" /> },
    { id: 'system', label: t('appearance.system'), icon: <Monitor className="w-4 h-4" /> },
  ];

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
  const [dynamicTheme, setDynamicTheme] = useState(() => {
    return localStorage.getItem('dynamic-theme') === 'true';
  });

  useEffect(() => {
    const root = document.documentElement;
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

  // Dynamic theme - auto switch based on time of day
  useEffect(() => {
    localStorage.setItem('dynamic-theme', String(dynamicTheme));
    if (!dynamicTheme) return;

    const applyDynamicTheme = () => {
      const hour = new Date().getHours();
      const root = document.documentElement;
      if (hour >= 6 && hour < 18) {
        root.classList.remove('dark');
        root.classList.add('light');
      } else {
        root.classList.remove('light');
        root.classList.add('dark');
      }
    };

    applyDynamicTheme();
    const interval = setInterval(applyDynamicTheme, 60000); // check every minute
    return () => clearInterval(interval);
  }, [dynamicTheme]);

  const handleDynamicThemeToggle = (enabled: boolean) => {
    setDynamicTheme(enabled);
    if (enabled) {
      setThemeMode('system'); // reset manual mode
    }
  };

  const { mode: uxMode, setMode: setUXMode } = useUXMode();

  const uxModes = [
    { id: 'focus' as const, label: 'Focus', icon: <Zap className="w-4 h-4" />, desc: 'Précis, direct, efficace' },
    { id: 'flow' as const, label: 'Flow', icon: <Waves className="w-4 h-4" />, desc: 'Chaleureux, fluide, immersif' },
  ];

  return (
    <div className="space-y-6">
      {/* UX Mode Switch */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expérience</h3>
        <div className="grid grid-cols-2 gap-3">
          {uxModes.map(m => (
            <button
              key={m.id}
              onClick={() => setUXMode(m.id)}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-300",
                uxMode === m.id
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-border/30 bg-secondary/20 hover:bg-secondary/40"
              )}
            >
              <div className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center transition-colors",
                uxMode === m.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )}>
                {m.icon}
              </div>
              <span className="text-sm font-semibold">{m.label}</span>
              <span className="text-[10px] text-muted-foreground text-center leading-tight">{m.desc}</span>
              {uxMode === m.id && <Check className="w-3.5 h-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('appearance.displayMode')}</h3>
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
              {themeMode === mode.id && <Check className="w-3.5 h-3.5 text-primary" />}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('appearance.accentColor')}</h3>
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
              <span className="text-xs font-medium truncate">{t(color.labelKey, color.fallback)}</span>
              {accentColor === color.id && <Check className="w-3.5 h-3.5 text-primary ml-auto flex-shrink-0" />}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('appearance.textSize')}</h3>
        <div className="flex items-center gap-3 px-1">
          <button onClick={() => setFontSize(Math.max(12, fontSize - 1))} className="w-8 h-8 rounded-full bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <div className="flex-1">
            <Slider value={[fontSize]} onValueChange={([v]) => setFontSize(v)} min={12} max={22} step={1} className="w-full" />
          </div>
          <button onClick={() => setFontSize(Math.min(22, fontSize + 1))} className="w-8 h-8 rounded-full bg-secondary/60 flex items-center justify-center hover:bg-secondary transition-colors">
            <Plus className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-muted-foreground w-8 text-center">{fontSize}px</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60 px-1">{t('appearance.preview')} : <span style={{ fontSize: `${fontSize}px` }}>{t('appearance.helloWorld')}</span></p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">🌗 Thème dynamique</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">Change automatiquement selon l'heure (clair le jour, sombre la nuit)</p>
          </div>
          <Switch checked={dynamicTheme} onCheckedChange={handleDynamicThemeToggle} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('appearance.compactMode')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('appearance.compactDesc')}</p>
          </div>
          <Switch checked={compactMode} onCheckedChange={setCompactMode} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('appearance.animations')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('appearance.animationsDesc')}</p>
          </div>
          <Switch checked={animationsEnabled} onCheckedChange={setAnimationsEnabled} />
        </div>
      </div>

      {/* Background customization */}
      <BackgroundSettingsSection />
    </div>
  );
}
