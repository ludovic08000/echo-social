import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBackgroundStyle } from '@/hooks/useCustomBackground';
import { reapplyAppearance } from '@/hooks/useUXMode';
import { BACKGROUND_MAX_BYTES, validateBackgroundFile } from '@/lib/appearance/backgroundValidation';

describe('appearance runtime', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the dynamic theme without overwriting the saved manual theme', () => {
    vi.useFakeTimers();
    localStorage.setItem('focus-theme-mode', 'dark');
    localStorage.setItem('focus-dynamic-theme', 'true');
    document.documentElement.classList.add('ux-focus');

    vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
    reapplyAppearance('focus');
    expect(document.documentElement).toHaveClass('light');
    expect(localStorage.getItem('focus-theme-mode')).toBe('dark');

    vi.setSystemTime(new Date(2026, 8, 30, 22, 0, 0));
    reapplyAppearance('focus');
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('focus-theme-mode')).toBe('dark');
  });

  it('uses the selected accent color in Flow mode', () => {
    localStorage.setItem('flow-theme-mode', 'dark');
    localStorage.setItem('flow-dynamic-theme', 'false');
    localStorage.setItem('flow-accent-color', 'emerald');
    document.documentElement.classList.add('ux-flow');

    reapplyAppearance('flow');

    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('160 65% 58%');
    expect(document.documentElement.style.getPropertyValue('--ring')).toBe('160 65% 58%');
    expect(document.documentElement.style.getPropertyValue('--premium-gradient')).toContain('hsl(160 65% 58%)');
  });

  it('keeps the Minimal preset compatible with both light and dark theme tokens', () => {
    const style = getBackgroundStyle('gradient:from-gray-100,via-gray-200,to-gray-300');
    expect(style?.background).toContain('hsl(var(--muted))');
    expect(style?.background).toContain('hsl(var(--background))');
  });

  it('rejects unsupported or oversized background images before upload', () => {
    expect(validateBackgroundFile({ type: 'image/gif', size: 100 })).toContain('Format non supporté');
    expect(validateBackgroundFile({ type: 'image/png', size: BACKGROUND_MAX_BYTES + 1 })).toContain('5 Mo');
    expect(validateBackgroundFile({ type: 'image/webp', size: BACKGROUND_MAX_BYTES })).toBeNull();
  });
});
