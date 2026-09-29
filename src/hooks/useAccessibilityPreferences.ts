import { useEffect, useState } from 'react';
import {
  readAccessibilityPreferences,
  subscribeAccessibilityPreferences,
} from '@/lib/accessibilityPreferences';

export function useAccessibilityPreferences() {
  const [preferences, setPreferences] = useState(readAccessibilityPreferences);

  useEffect(() => subscribeAccessibilityPreferences(setPreferences), []);

  return preferences;
}
