import { useState, useEffect } from 'react';
import { Contrast, MousePointer, Keyboard, Languages } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTranslation, type SupportedLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface AccessibilityPrefs {
  reducedMotion: boolean;
  highContrast: boolean;
  screenReaderOptimized: boolean;
  largeClickTargets: boolean;
  keyboardNavigation: boolean;
  autoplayVideos: boolean;
  captionsEnabled: boolean;
  colorBlindMode: string;
  language: string;
  lineSpacing: number;
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

const languageOptions = [
  { value: 'fr', label: '🇫🇷 Français' },
  { value: 'en', label: '🇬🇧 English' },
  { value: 'es', label: '🇪🇸 Español' },
  { value: 'de', label: '🇩🇪 Deutsch' },
];

export function AccessibilitySettingsPanel() {
  const { locale, setLocale, t } = useTranslation();
  const [prefs, setPrefs] = useState<AccessibilityPrefs>(() => {
    try {
      const saved = localStorage.getItem('accessibility-prefs');
      return saved ? { ...defaultPrefs, ...JSON.parse(saved) } : defaultPrefs;
    } catch {
      return defaultPrefs;
    }
  });

  const colorBlindOptions = [
    { value: 'none', label: t('access.colorBlindNone') },
    { value: 'deuteranopia', label: t('access.colorBlindDeuteranopia') },
    { value: 'protanopia', label: t('access.colorBlindProtanopia') },
    { value: 'tritanopia', label: t('access.colorBlindTritanopia') },
  ];

  const shortcuts = [
    { keys: ['N'], desc: t('access.shortcutNewPost') },
    { keys: ['/', 'S'], desc: t('access.shortcutSearch') },
    { keys: ['G', 'H'], desc: t('access.shortcutGoFeed') },
    { keys: ['G', 'P'], desc: t('access.shortcutGoProfile') },
    { keys: ['G', 'M'], desc: t('access.shortcutMessages') },
    { keys: ['G', 'N'], desc: t('access.shortcutNotifications') },
    { keys: ['J'], desc: t('access.shortcutNextPost') },
    { keys: ['K'], desc: t('access.shortcutPrevPost') },
    { keys: ['L'], desc: t('access.shortcutLike') },
    { keys: ['C'], desc: t('access.shortcutComment') },
    { keys: ['Esc'], desc: t('access.shortcutClose') },
  ];

  useEffect(() => {
    localStorage.setItem('accessibility-prefs', JSON.stringify({ ...prefs, language: locale }));
    const root = document.documentElement;
    root.classList.toggle('reduced-motion', prefs.reducedMotion);
    root.classList.toggle('high-contrast', prefs.highContrast);
    root.classList.toggle('large-targets', prefs.largeClickTargets);
    root.style.setProperty('--line-height-factor', String(prefs.lineSpacing));
  }, [prefs, locale]);

  const update = (patch: Partial<AccessibilityPrefs>) => {
    setPrefs(prev => ({ ...prev, ...patch }));
  };

  const handleLanguageChange = (v: string) => {
    setLocale(v as SupportedLocale);
    update({ language: v });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Languages className="w-3.5 h-3.5" />
          {t('access.language')}
        </h3>
        <Select value={locale} onValueChange={handleLanguageChange}>
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

      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <Contrast className="w-3.5 h-3.5" />
          {t('access.display')}
        </h3>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.highContrast')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.highContrastDesc')}</p>
          </div>
          <Switch checked={prefs.highContrast} onCheckedChange={v => update({ highContrast: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.reducedMotion')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.reducedMotionDesc')}</p>
          </div>
          <Switch checked={prefs.reducedMotion} onCheckedChange={v => update({ reducedMotion: v })} />
        </div>
        <div className="space-y-2 p-3">
          <Label className="text-sm font-medium">{t('access.colorBlind')}</Label>
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
            <Label className="text-sm font-medium">{t('access.lineSpacing')}</Label>
            <span className="text-xs text-muted-foreground">{prefs.lineSpacing.toFixed(1)}</span>
          </div>
          <Slider value={[prefs.lineSpacing * 10]} onValueChange={([v]) => update({ lineSpacing: v / 10 })} min={10} max={25} step={1} />
        </div>
      </div>

      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
          <MousePointer className="w-3.5 h-3.5" />
          {t('access.interaction')}
        </h3>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.largeTargets')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.largeTargetsDesc')}</p>
          </div>
          <Switch checked={prefs.largeClickTargets} onCheckedChange={v => update({ largeClickTargets: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.autoplay')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.autoplayDesc')}</p>
          </div>
          <Switch checked={prefs.autoplayVideos} onCheckedChange={v => update({ autoplayVideos: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.captions')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.captionsDesc')}</p>
          </div>
          <Switch checked={prefs.captionsEnabled} onCheckedChange={v => update({ captionsEnabled: v })} />
        </div>
        <div className="flex items-center justify-between p-3 rounded-xl hover:bg-secondary/30 transition-colors">
          <div>
            <Label className="text-sm font-medium">{t('access.screenReader')}</Label>
            <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t('access.screenReaderDesc')}</p>
          </div>
          <Switch checked={prefs.screenReaderOptimized} onCheckedChange={v => update({ screenReaderOptimized: v })} />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Keyboard className="w-3.5 h-3.5" />
            {t('access.shortcuts')}
          </h3>
          <Switch checked={prefs.keyboardNavigation} onCheckedChange={v => update({ keyboardNavigation: v })} />
        </div>
        {prefs.keyboardNavigation && (
          <div className="rounded-xl border border-border/30 overflow-hidden">
            {shortcuts.map((shortcut, i) => (
              <div key={shortcut.desc} className={cn("flex items-center justify-between px-4 py-2.5 text-xs", i < shortcuts.length - 1 && "border-b border-border/20")}>
                <span className="text-muted-foreground">{shortcut.desc}</span>
                <div className="flex gap-1">
                  {shortcut.keys.map((key, j) => (
                    <span key={j}>
                      <kbd className="px-2 py-0.5 rounded-md bg-secondary/60 border border-border/30 text-[10px] font-mono font-semibold">{key}</kbd>
                      {j < shortcut.keys.length - 1 && <span className="text-muted-foreground/50 mx-0.5">+</span>}
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
