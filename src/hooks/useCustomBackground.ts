import { useProfile } from '@/hooks/useProfile';

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

export function getBackgroundStyle(url: string | null | undefined): React.CSSProperties | undefined {
  if (!url) return undefined;

  if (url.startsWith('gradient:')) {
    const css = GRADIENT_MAP[url];
    return css ? { background: css } : undefined;
  }

  return {
    backgroundImage: `url(${url})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundAttachment: 'fixed',
  };
}

export function useCustomBackground(type: 'profile' | 'feed') {
  const { data: profile } = useProfile();
  const url = type === 'profile' ? (profile as any)?.profile_bg_url : (profile as any)?.feed_bg_url;
  return getBackgroundStyle(url);
}
