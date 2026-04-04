// Allowed origins for CORS — production + preview domains
const ALLOWED_ORIGINS = [
  'https://forsure.fans',
  'https://www.forsure.fans',
];

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow Lovable preview/dev domains
  if (/^https:\/\/[a-z0-9-]+--[a-f0-9-]+\.lovable\.app$/.test(origin)) return true;
  if (origin === 'https://calm-connect-05.lovable.app') return true;
  return false;
}

export function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || '';
  const allowed = isAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
    'Vary': 'Origin',
  };
}

// Legacy export — avoid using this, prefer getCorsHeaders(req) for proper origin handling
export const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://forsure.fans',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};
