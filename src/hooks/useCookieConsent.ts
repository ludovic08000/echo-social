import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

type ConsentStatus = 'pending' | 'accepted' | 'declined';

const STORAGE_KEY = 'forsure_cookie_consent';
const SIGNATURE_KEY = 'forsure_cookie_consent_sig';

/**
 * HMAC-based integrity check so localStorage can't be tampered with.
 */
async function computeSignature(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode('forsure-consent-integrity-2026'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifySignature(value: string, signature: string): Promise<boolean> {
  const expected = await computeSignature(value);
  return expected === signature;
}

export function useCookieConsent() {
  const [consent, setConsent] = useState<ConsentStatus>('pending');
  const [loading, setLoading] = useState(true);

  // Load stored consent on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        const sig = localStorage.getItem(SIGNATURE_KEY);
        if (stored && sig) {
          const valid = await verifySignature(stored, sig);
          if (valid && (stored === 'accepted' || stored === 'declined')) {
            setConsent(stored as ConsentStatus);
          } else {
            // Tampered — reset
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(SIGNATURE_KEY);
          }
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setConsentValue = useCallback(async (value: 'accepted' | 'declined') => {
    setLoading(true);
    try {
      // 1. Set HttpOnly cookie via edge function
      await supabase.functions.invoke('set-cookie-consent', {
        body: { consent: value },
      });

      // 2. Store in localStorage with HMAC signature (for UI state)
      const sig = await computeSignature(value);
      localStorage.setItem(STORAGE_KEY, value);
      localStorage.setItem(SIGNATURE_KEY, sig);

      setConsent(value);
    } catch (err) {
      console.error('Failed to set cookie consent:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const acceptCookies = useCallback(() => setConsentValue('accepted'), [setConsentValue]);
  const declineCookies = useCallback(() => setConsentValue('declined'), [setConsentValue]);

  return {
    consent,
    loading,
    showBanner: !loading && consent === 'pending',
    acceptCookies,
    declineCookies,
  };
}
