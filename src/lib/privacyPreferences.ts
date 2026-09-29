export interface RuntimePrivacyPreferences {
  ghostMode: boolean;
  analyticsEnabled: boolean;
  onlineStatusVisibility: 'everyone' | 'friends' | 'nobody';
}

export const PRIVACY_RUNTIME_CHANGED_EVENT = 'forsure:privacy-runtime-changed';
const PREFIX = 'forsure:privacy-runtime:';

const DEFAULT_RUNTIME_PRIVACY: RuntimePrivacyPreferences = {
  ghostMode: false,
  analyticsEnabled: false,
  onlineStatusVisibility: 'friends',
};

function key(userId: string) {
  return `${PREFIX}${userId}`;
}

export function readRuntimePrivacyPreferences(userId?: string | null): RuntimePrivacyPreferences {
  if (!userId || typeof window === 'undefined') return DEFAULT_RUNTIME_PRIVACY;
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return DEFAULT_RUNTIME_PRIVACY;
    const value = JSON.parse(raw) as Partial<RuntimePrivacyPreferences>;
    return {
      ghostMode: value.ghostMode === true,
      analyticsEnabled: value.analyticsEnabled === true,
      onlineStatusVisibility: ['everyone', 'friends', 'nobody'].includes(String(value.onlineStatusVisibility))
        ? value.onlineStatusVisibility as RuntimePrivacyPreferences['onlineStatusVisibility']
        : 'friends',
    };
  } catch {
    return DEFAULT_RUNTIME_PRIVACY;
  }
}

export function writeRuntimePrivacyPreferences(
  userId: string,
  value: Partial<RuntimePrivacyPreferences>,
) {
  const next = { ...readRuntimePrivacyPreferences(userId), ...value };
  try {
    localStorage.setItem(key(userId), JSON.stringify(next));
  } catch {
    // Privacy remains fail-closed when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(PRIVACY_RUNTIME_CHANGED_EVENT, {
    detail: { userId, preferences: next },
  }));
}

export function subscribeRuntimePrivacyPreferences(
  userId: string,
  listener: (preferences: RuntimePrivacyPreferences) => void,
) {
  const onChanged = (event: Event) => {
    const detail = (event as CustomEvent<{
      userId: string;
      preferences: RuntimePrivacyPreferences;
    }>).detail;
    if (detail?.userId === userId) listener(detail.preferences);
  };
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === key(userId)) listener(readRuntimePrivacyPreferences(userId));
  };
  window.addEventListener(PRIVACY_RUNTIME_CHANGED_EVENT, onChanged);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PRIVACY_RUNTIME_CHANGED_EVENT, onChanged);
    window.removeEventListener('storage', onStorage);
  };
}

export function isGhostModeEnabled(userId?: string | null) {
  return readRuntimePrivacyPreferences(userId).ghostMode;
}

export function isAnalyticsEnabled(userId?: string | null) {
  return readRuntimePrivacyPreferences(userId).analyticsEnabled;
}
