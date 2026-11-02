import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useVoiceSettings } from '@/hooks/useVoiceSettings';

describe('useVoiceSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    window.dispatchEvent(new Event('forsure:voice-settings-changed'));
  });

  it('requires an explicit voice opt-in after migrating an older local setting', () => {
    localStorage.setItem('forsure-voice-settings', JSON.stringify({
      voice_enabled: true,
      voice_lang: 'fr-FR',
    }));
    window.dispatchEvent(new Event('forsure:voice-settings-changed'));

    const { result } = renderHook(() => useVoiceSettings());
    expect(result.current.voiceSettings.voice_enabled).toBe(false);
  });

  it('synchronizes a voice choice across mounted consumers', () => {
    const first = renderHook(() => useVoiceSettings());
    const second = renderHook(() => useVoiceSettings());

    act(() => first.result.current.updateVoiceSettings({ voice_enabled: true }));

    expect(first.result.current.voiceSettings.voice_enabled).toBe(true);
    expect(second.result.current.voiceSettings.voice_enabled).toBe(true);
  });

  it('persists an explicit activation until the user changes the choice', () => {
    const { result, unmount } = renderHook(() => useVoiceSettings());

    act(() => result.current.updateVoiceSettings({ voice_enabled: true }));
    unmount();

    expect(JSON.parse(localStorage.getItem('forsure-voice-settings') || '{}')).toMatchObject({
      voice_enabled: true,
      voice_consent_version: 1,
    });
    expect(renderHook(() => useVoiceSettings()).result.current.voiceSettings.voice_enabled).toBe(true);
  });
});
