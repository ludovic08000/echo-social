import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('appearance settings architecture', () => {
  it('renders account and profile backgrounds above the application surface', () => {
    const feed = readSource('src/pages/Feed.tsx');
    const profile = readSource('src/pages/Profile.tsx');
    const layout = readSource('src/components/AppLayout.tsx');

    expect(feed).toContain("useCustomBackground(profileId ? 'profile' : 'feed', profileId)");
    expect(feed).toContain('pointer-events-none fixed inset-0 z-0');
    expect(feed).not.toContain('fixed inset-0 -z-10');
    expect(profile).not.toContain('fixed inset-0 -z-10');
    expect(layout).toContain('relative isolate min-h-screen bg-background');
  });

  it('keeps dynamic/system themes and reduced motion active outside settings', () => {
    const app = readSource('src/App.tsx');
    const settingsRuntime = readSource('src/hooks/useSettingsInit.ts');

    expect(app).toContain('<MotionConfig');
    expect(app).toContain('reducedMotion={animationsDisabled ? "always" : "user"}');
    expect(settingsRuntime).toContain("window.matchMedia('(prefers-color-scheme: dark)')");
    expect(settingsRuntime).toContain('APPEARANCE_CHANGED_EVENT');
    expect(settingsRuntime).toContain('60_000');
  });

  it('resets persisted backgrounds without wiping unrelated root styles', () => {
    const panel = readSource('src/components/settings/AppearanceSettingsPanel.tsx');

    expect(panel).toContain('updateProfile.mutateAsync({ profile_bg_url: null, feed_bg_url: null })');
    expect(panel).not.toContain("removeAttribute('style')");
    expect(panel).toContain("window.dispatchEvent(new Event('forsure:appearance-reset'))");
  });

  it('waits for background persistence and validates uploads before success', () => {
    const backgrounds = readSource('src/components/settings/BackgroundSettingsSection.tsx');

    expect(backgrounds).toContain('await onUpdate(url)');
    expect(backgrounds).toContain('validateBackgroundFile(file)');
    expect(backgrounds).toContain('mutateAsync({ profile_bg_url: url })');
    expect(backgrounds).toContain('mutateAsync({ feed_bg_url: url })');
  });
});
