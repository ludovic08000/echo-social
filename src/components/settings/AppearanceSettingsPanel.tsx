import { useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Check, Minus, Plus, Zap, Waves } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/lib/i18n';
import { BackgroundSettingsSection } from './BackgroundSettingsSection';
import { FeedCustomizationSection } from './FeedCustomizationSection';
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
  const { mode: uxMode } = useUXMode();

  // Helper: mode-scoped localStorage key
  const modeKey = (key: string) => `${uxMode}-${key}`;

  const themeModes: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { id: 'light', label: t('appearance.light'), icon: <Sun className="w-4 h-4" /> },
    { id: 'dark', label: t('appearance.dark'), icon: <Moon className="w-4 h-4" /> },
    { id: 'system', label: t('appearance.system'), icon: <Monitor className="w-4 h-4" /> },
  ];

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem(modeKey('theme-mode')) as ThemeMode) || (localStorage.getItem('theme-mode') as ThemeMode) || 'dark';
  });
  const [accentColor, setAccentColor] = useState(() => {
    return localStorage.getItem(modeKey('accent-color')) || localStorage.getItem('accent-color') || 'bleu';
  });
  const [fontSize, setFontSize] = useState(() => {
    return parseInt(localStorage.getItem(modeKey('font-size')) || localStorage.getItem('font-size') || '16', 10);
  });
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem(modeKey('compact-mode')) === 'true';
  });
  const [animationsEnabled, setAnimationsEnabled] = useState(() => {
    return localStorage.getItem(modeKey('animations-disabled')) !== 'true';
  });
  const [dynamicTheme, setDynamicTheme] = useState(() => {
    return localStorage.getItem(modeKey('dynamic-theme')) === 'true';
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
    localStorage.setItem(modeKey('theme-mode'), themeMode);
    localStorage.setItem('theme-mode', themeMode); // keep global fallback
  }, [themeMode, uxMode]);

  useEffect(() => {
    const color = accentColors.find(c => c.id === accentColor);
    if (color) {
      const root = document.documentElement;
      const hsl = color.hsl;
      const parts = hsl.split(' ');
      const h = parseInt(parts[0]);
      const s = parseInt(parts[1]);
      const l = parseInt(parts[2]);
      const isDark = root.classList.contains('dark');

      // Primary & ring
      root.style.setProperty('--primary', hsl);
      root.style.setProperty('--primary-foreground', isDark ? `${h} ${Math.max(s - 40, 5)}% 98%` : `0 0% 100%`);
      root.style.setProperty('--ring', hsl);

      // Sidebar
      root.style.setProperty('--sidebar-primary', hsl);
      root.style.setProperty('--sidebar-ring', hsl);
      root.style.setProperty('--sidebar-accent', isDark ? `${h} ${Math.max(s - 40, 8)}% 18%` : `${h} ${Math.max(s - 30, 10)}% 94%`);
      root.style.setProperty('--sidebar-accent-foreground', isDark ? `${h} ${Math.max(s - 15, 20)}% 80%` : `${h} ${s}% 35%`);

      // Glow & shadows
      root.style.setProperty('--shadow-glow', `0 0 40px hsl(${hsl} / 0.25)`);
      root.style.setProperty('--shadow-gold', `0 4px 25px -4px hsl(${hsl} / 0.3)`);

      // Gradient
      root.style.setProperty('--premium-gradient', `linear-gradient(135deg, hsl(${h} ${s}% ${l}%) 0%, hsl(${h + 15} ${Math.max(s - 10, 30)}% ${l + 5}%) 50%, hsl(${h + 30} ${s}% ${l + 8}%) 100%)`);

      if (isDark) {
        // Tinted dark backgrounds
        root.style.setProperty('--background', `${h} ${Math.max(s - 55, 8)}% 10%`);
        root.style.setProperty('--foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--card', `${h} ${Math.max(s - 52, 8)}% 12%`);
        root.style.setProperty('--card-foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--popover', `${h} ${Math.max(s - 52, 8)}% 12%`);
        root.style.setProperty('--popover-foreground', `${h} ${Math.max(s - 50, 5)}% 92%`);
        root.style.setProperty('--muted', `${h} ${Math.max(s - 50, 6)}% 16%`);
        root.style.setProperty('--muted-foreground', `${h} ${Math.max(s - 45, 8)}% 55%`);
        root.style.setProperty('--accent', `${h} ${Math.max(s - 30, 10)}% 20%`);
        root.style.setProperty('--accent-foreground', `${h} ${Math.max(s - 10, 30)}% 72%`);
        root.style.setProperty('--secondary', `${h} ${Math.max(s - 48, 8)}% 15%`);
        root.style.setProperty('--secondary-foreground', `${h} ${Math.max(s - 40, 10)}% 82%`);
        root.style.setProperty('--border', `${h} ${Math.max(s - 50, 6)}% 18%`);
        root.style.setProperty('--input', `${h} ${Math.max(s - 50, 6)}% 18%`);
      } else {
        // Tinted light backgrounds
        root.style.setProperty('--background', `${h} ${Math.max(s - 45, 10)}% 98%`);
        root.style.setProperty('--foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--card', `${h} ${Math.max(s - 40, 8)}% 99%`);
        root.style.setProperty('--card-foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--popover', `${h} ${Math.max(s - 40, 8)}% 99%`);
        root.style.setProperty('--popover-foreground', `${h} ${Math.max(s - 40, 10)}% 12%`);
        root.style.setProperty('--muted', `${h} ${Math.max(s - 40, 8)}% 94%`);
        root.style.setProperty('--muted-foreground', `${h} ${Math.max(s - 35, 10)}% 42%`);
        root.style.setProperty('--accent', `${h} ${Math.max(s - 25, 15)}% 94%`);
        root.style.setProperty('--accent-foreground', `${h} ${s}% 40%`);
        root.style.setProperty('--secondary', `${h} ${Math.max(s - 40, 10)}% 93%`);
        root.style.setProperty('--secondary-foreground', `${h} ${Math.max(s - 35, 10)}% 25%`);
        root.style.setProperty('--border', `${h} ${Math.max(s - 45, 8)}% 88%`);
        root.style.setProperty('--input', `${h} ${Math.max(s - 45, 8)}% 88%`);
      }
    }
    localStorage.setItem(modeKey('accent-color'), accentColor);
  }, [accentColor, themeMode, uxMode]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
    localStorage.setItem(modeKey('font-size'), String(fontSize));
  }, [fontSize, uxMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('compact-mode', compactMode);
    localStorage.setItem(modeKey('compact-mode'), String(compactMode));
  }, [compactMode, uxMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('no-animations', !animationsEnabled);
    localStorage.setItem(modeKey('animations-disabled'), String(!animationsEnabled));
  }, [animationsEnabled, uxMode]);

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

  const { setMode: setUXMode } = useUXMode();

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

      {/* Feed customization: font, text color, background color */}
      <FeedCustomizationSection />

      {/* Background customization */}
      <BackgroundSettingsSection />
    </div>
  );
}
