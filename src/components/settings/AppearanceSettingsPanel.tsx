import { useState, useEffect, useCallback } from 'react';
import { Sun, Moon, Monitor, Check, Minus, Plus, Zap, Waves, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/lib/i18n';
import { BackgroundSettingsSection } from './BackgroundSettingsSection';
import { FeedCustomizationSection } from './FeedCustomizationSection';
import { useAuth } from '@/lib/auth';
import { useUpdateProfile } from '@/hooks/useProfile';
import { notifyAppearanceChanged, useUXMode, reapplyAppearance } from '@/hooks/useUXMode';
import { toast } from 'sonner';

type ThemeMode = 'light' | 'dark' | 'system';

const appearanceModeKey = (mode: string, key: string) => `${mode}-${key}`;

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
  const { user } = useAuth();
  const updateProfile = useUpdateProfile();
  const [isResetting, setIsResetting] = useState(false);

  const themeModes: { id: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { id: 'light', label: t('appearance.light'), icon: <Sun className="w-4 h-4" /> },
    { id: 'dark', label: t('appearance.dark'), icon: <Moon className="w-4 h-4" /> },
    { id: 'system', label: t('appearance.system'), icon: <Monitor className="w-4 h-4" /> },
  ];

  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem(appearanceModeKey(uxMode, 'theme-mode')) as ThemeMode) || (localStorage.getItem('theme-mode') as ThemeMode) || 'dark';
  });
  const [accentColor, setAccentColor] = useState(() => {
    return localStorage.getItem(appearanceModeKey(uxMode, 'accent-color')) || localStorage.getItem('accent-color') || 'bleu';
  });
  const [fontSize, setFontSize] = useState(() => {
    return parseInt(localStorage.getItem(appearanceModeKey(uxMode, 'font-size')) || localStorage.getItem('font-size') || '16', 10);
  });
  const [compactMode, setCompactMode] = useState(() => {
    return (localStorage.getItem(appearanceModeKey(uxMode, 'compact-mode')) ?? localStorage.getItem('compact-mode')) === 'true';
  });
  const [animationsEnabled, setAnimationsEnabled] = useState(() => {
    return (localStorage.getItem(appearanceModeKey(uxMode, 'animations-disabled')) ?? localStorage.getItem('animations-disabled')) !== 'true';
  });
  const [dynamicTheme, setDynamicTheme] = useState(() => {
    return (localStorage.getItem(appearanceModeKey(uxMode, 'dynamic-theme')) ?? localStorage.getItem('dynamic-theme')) === 'true';
  });

  // Save theme + accent to localStorage, then let reapplyAppearance handle ALL CSS vars
  useEffect(() => {
    localStorage.setItem(appearanceModeKey(uxMode, 'theme-mode'), themeMode);
    reapplyAppearance(uxMode);
    notifyAppearanceChanged(uxMode);
  }, [themeMode, uxMode]);

  useEffect(() => {
    localStorage.setItem(appearanceModeKey(uxMode, 'accent-color'), accentColor);
    reapplyAppearance(uxMode);
    notifyAppearanceChanged(uxMode);
  }, [accentColor, uxMode]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${fontSize}px`;
    localStorage.setItem(appearanceModeKey(uxMode, 'font-size'), String(fontSize));
    notifyAppearanceChanged(uxMode);
  }, [fontSize, uxMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('compact-mode', compactMode);
    localStorage.setItem(appearanceModeKey(uxMode, 'compact-mode'), String(compactMode));
    notifyAppearanceChanged(uxMode);
  }, [compactMode, uxMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('no-animations', !animationsEnabled);
    localStorage.setItem(appearanceModeKey(uxMode, 'animations-disabled'), String(!animationsEnabled));
    notifyAppearanceChanged(uxMode);
  }, [animationsEnabled, uxMode]);

  // The app-level appearance runtime owns the clock, so this remains active
  // after the settings panel is closed.
  useEffect(() => {
    localStorage.setItem(appearanceModeKey(uxMode, 'dynamic-theme'), String(dynamicTheme));
    reapplyAppearance(uxMode);
    notifyAppearanceChanged(uxMode);
  }, [dynamicTheme, uxMode]);

  const handleDynamicThemeToggle = (enabled: boolean) => {
    setDynamicTheme(enabled);
  };

  const handleThemeModeChange = (nextTheme: ThemeMode) => {
    if (dynamicTheme) {
      localStorage.setItem(appearanceModeKey(uxMode, 'dynamic-theme'), 'false');
      setDynamicTheme(false);
    }
    setThemeMode(nextTheme);
  };

  const { setMode: setUXMode } = useUXMode();

  const uxModes = [
    { id: 'focus' as const, label: 'Focus', icon: <Zap className="w-4 h-4" />, desc: 'Précis, direct, efficace' },
    { id: 'flow' as const, label: 'Flow', icon: <Waves className="w-4 h-4" />, desc: 'Chaleureux, fluide, immersif' },
  ];

  const resetToDefaults = useCallback(async () => {
    setIsResetting(true);
    try {
      // Backgrounds are account settings, not browser-only preferences.
      if (user) {
        await updateProfile.mutateAsync({ profile_bg_url: null, feed_bg_url: null });
      }

      const keys = ['theme-mode', 'accent-color', 'font-size', 'compact-mode', 'animations-disabled', 'dynamic-theme', 'feed-customization', 'custom-bg-url'];
      keys.forEach(k => {
        localStorage.removeItem(appearanceModeKey(uxMode, k));
        localStorage.removeItem(k);
      });

      // Preserve unrelated root styles (for example the wellbeing grayscale).
      const root = document.documentElement;
      root.classList.remove('compact-mode', 'no-animations');

      setThemeMode('dark');
      setAccentColor('bleu');
      setFontSize(16);
      setCompactMode(false);
      setAnimationsEnabled(true);
      setDynamicTheme(false);

      reapplyAppearance(uxMode);
      notifyAppearanceChanged(uxMode);
      window.dispatchEvent(new Event('forsure:appearance-reset'));
      toast.success('Apparence réinitialisée');
    } catch (error) {
      console.error('Appearance reset failed:', error);
      toast.error('Impossible de réinitialiser les fonds du compte');
    } finally {
      setIsResetting(false);
    }
  }, [updateProfile, user, uxMode]);


  return (
    <div className="space-y-6">
      {/* Reset button */}
      <button
        onClick={() => void resetToDefaults()}
        disabled={isResetting}
        className="w-full flex items-center justify-center gap-2 p-3 rounded-2xl border border-border/40 bg-secondary/30 hover:bg-destructive/10 hover:border-destructive/30 text-muted-foreground hover:text-destructive transition-all duration-200 text-sm font-medium"
      >
        <RotateCcw className="w-4 h-4" />
        {isResetting ? 'Réinitialisation…' : 'Réinitialiser par défaut'}
      </button>
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
                  : "border-border bg-secondary/40 hover:bg-secondary/60"
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
              onClick={() => handleThemeModeChange(mode.id)}
              className={cn(
                "flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all duration-200",
                themeMode === mode.id
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-border bg-secondary/40 hover:bg-secondary/60"
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
                  ? "border-primary bg-primary/15 ring-1 ring-primary/40"
                  : "border-border bg-secondary/40 hover:border-primary/40 hover:bg-secondary/60"
              )}
            >
              <div className={cn("w-8 h-8 rounded-full shadow-md flex-shrink-0 ring-2 ring-white/20", color.preview)} />
              <span className="text-xs font-semibold truncate">{t(color.labelKey, color.fallback)}</span>
              {accentColor === color.id && <Check className="w-4 h-4 text-primary ml-auto flex-shrink-0" />}
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
