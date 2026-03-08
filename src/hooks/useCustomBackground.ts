import { useState, useEffect } from 'react';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/integrations/supabase/client';

const GRADIENT_MAP: Record<string, string> = {
  'gradient:from-orange-400,via-pink-500,to-purple-600': 'linear-gradient(135deg, #fb923c, #ec4899, #9333ea)',
  'gradient:from-cyan-400,via-blue-500,to-indigo-600': 'linear-gradient(135deg, #22d3ee, #3b82f6, #4f46e5)',
  'gradient:from-emerald-400,via-green-500,to-teal-600': 'linear-gradient(135deg, #34d399, #22c55e, #0d9488)',
  'gradient:from-slate-800,via-indigo-900,to-black': 'linear-gradient(135deg, #1e293b, #312e81, #000)',
  'gradient:from-rose-300,via-pink-400,to-fuchsia-500': 'linear-gradient(135deg, #fda4af, #f472b6, #d946ef)',
  'gradient:from-green-300,via-cyan-400,to-purple-500': 'linear-gradient(135deg, #86efac, #22d3ee, #a855f7)',
  'gradient:from-amber-300,via-orange-400,to-red-500': 'linear-gradient(135deg, #fcd34d, #fb923c, #ef4444)',
  'gradient:from-gray-100,via-gray-200,to-gray-300': 'linear-gradient(135deg, #f3f4f6, #e5e7eb, #d1d5db)',
};

// Signed URL cache to avoid re-generating on every render
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const SIGNED_URL_DURATION = 3600; // 1 hour in seconds
const CACHE_BUFFER = 300; // refresh 5 min before expiry

async function getSignedUrl(storagePath: string): Promise<string | null> {
  const cached = signedUrlCache.get(storagePath);
  const now = Date.now() / 1000;

  if (cached && cached.expiresAt - CACHE_BUFFER > now) {
    return cached.url;
  }

  const { data, error } = await supabase.storage
    .from('backgrounds')
    .createSignedUrl(storagePath, SIGNED_URL_DURATION);

  if (error || !data?.signedUrl) {
    console.error('Failed to create signed URL:', error);
    return null;
  }

  signedUrlCache.set(storagePath, {
    url: data.signedUrl,
    expiresAt: now + SIGNED_URL_DURATION,
  });

  return data.signedUrl;
}

export function getBackgroundStyle(url: string | null | undefined): React.CSSProperties | undefined {
  if (!url) return undefined;

  if (url.startsWith('gradient:')) {
    const css = GRADIENT_MAP[url];
    return css ? { background: css } : undefined;
  }

  // For storage: paths, the signed URL is resolved async via the hook
  // This function handles already-resolved URLs
  if (url.startsWith('storage:')) {
    return undefined; // Will be handled by the hook
  }

  // Legacy public URLs (backward compat)
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundAttachment: 'fixed',
  };
}

export function useCustomBackground(type: 'profile' | 'feed') {
  const { data: profile } = useProfile();
  const url = type === 'profile' ? profile?.profile_bg_url : profile?.feed_bg_url;
  const [resolvedStyle, setResolvedStyle] = useState<React.CSSProperties | undefined>(undefined);

  useEffect(() => {
    if (!url) {
      setResolvedStyle(undefined);
      return;
    }

    if (url.startsWith('gradient:')) {
      const css = GRADIENT_MAP[url];
      setResolvedStyle(css ? { background: css } : undefined);
      return;
    }

    if (url.startsWith('storage:')) {
      const storagePath = url.replace('storage:', '');
      getSignedUrl(storagePath).then((signedUrl) => {
        if (signedUrl) {
          setResolvedStyle({
            backgroundImage: `url(${signedUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundAttachment: 'fixed',
          });
        } else {
          setResolvedStyle(undefined);
        }
      });
      return;
    }

    // Legacy public URLs
    setResolvedStyle({
      backgroundImage: `url(${url})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed',
    });
  }, [url]);

  return resolvedStyle;
}
