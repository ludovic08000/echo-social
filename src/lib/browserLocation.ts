export interface BrowserLocationContext {
  timeZone: string | null;
  languages: string[];
}

const cleanLanguage = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 35 && /^[A-Za-z0-9-]+$/.test(normalized)
    ? normalized
    : null;
};

export function browserLocaleContext(): BrowserLocationContext {
  if (typeof navigator === 'undefined') return { timeZone: null, languages: [] };
  const languages = Array.from(new Set(
    [...(navigator.languages || []), navigator.language]
      .map(cleanLanguage)
      .filter((value): value is string => Boolean(value)),
  )).slice(0, 6);
  let timeZone: string | null = null;
  try {
    const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (candidate && candidate.length <= 64 && /^[A-Za-z0-9_+./-]+$/.test(candidate)) timeZone = candidate;
  } catch {
    // The IP fallback remains available in restricted browsers.
  }
  return { timeZone, languages };
}

export async function browserLocationContext(): Promise<BrowserLocationContext> {
  return browserLocaleContext();
}
