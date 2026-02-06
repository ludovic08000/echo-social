import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import fr from './locales/fr';
import en from './locales/en';
import es from './locales/es';
import de from './locales/de';
import ar from './locales/ar';
import zh from './locales/zh';

export type SupportedLocale = 'fr' | 'en' | 'es' | 'de' | 'ar' | 'zh';

type TranslationMap = Record<string, string>;

const locales: Record<SupportedLocale, TranslationMap> = { fr, en, es, de, ar, zh };

// French is the fallback
const fallback = fr;

interface I18nContextType {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: string, fallbackText?: string) => string;
  dir: 'ltr' | 'rtl';
}

const I18nContext = createContext<I18nContextType>({
  locale: 'fr',
  setLocale: () => {},
  t: (key: string) => key,
  dir: 'ltr',
});

function getInitialLocale(): SupportedLocale {
  try {
    // Check accessibility prefs first (where the language select is)
    const accessPrefs = localStorage.getItem('accessibility-prefs');
    if (accessPrefs) {
      const parsed = JSON.parse(accessPrefs);
      if (parsed.language && parsed.language in locales) {
        return parsed.language as SupportedLocale;
      }
    }
    // Then check dedicated i18n key
    const saved = localStorage.getItem('app-locale');
    if (saved && saved in locales) {
      return saved as SupportedLocale;
    }
  } catch {}
  return 'fr';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<SupportedLocale>(getInitialLocale);

  const setLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    localStorage.setItem('app-locale', newLocale);
    
    // Also sync with accessibility-prefs
    try {
      const accessPrefs = localStorage.getItem('accessibility-prefs');
      if (accessPrefs) {
        const parsed = JSON.parse(accessPrefs);
        parsed.language = newLocale;
        localStorage.setItem('accessibility-prefs', JSON.stringify(parsed));
      }
    } catch {}
  }, []);

  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);

  const t = useCallback((key: string, fallbackText?: string): string => {
    const translations = locales[locale];
    return translations?.[key] || fallback[key] || fallbackText || key;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, dir }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  return useContext(I18nContext);
}

export { locales };
