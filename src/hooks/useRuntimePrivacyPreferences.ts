import { useEffect, useState } from 'react';
import {
  readRuntimePrivacyPreferences,
  subscribeRuntimePrivacyPreferences,
} from '@/lib/privacyPreferences';

export function useRuntimePrivacyPreferences(userId?: string | null) {
  const [preferences, setPreferences] = useState(() => readRuntimePrivacyPreferences(userId));

  useEffect(() => {
    if (!userId) {
      setPreferences(readRuntimePrivacyPreferences(null));
      return;
    }
    setPreferences(readRuntimePrivacyPreferences(userId));
    return subscribeRuntimePrivacyPreferences(userId, setPreferences);
  }, [userId]);

  return preferences;
}
