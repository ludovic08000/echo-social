// Allowed origins for CORS — restricted to actual app domains only (no wildcards)
const ALLOWED_ORIGINS = [
  'https://calm-connect-05.lovable.app',
  'https://id-preview--14bf9f2a-b211-4bff-8f3c-1cd3d8a0a907.lovable.app',
  'https://forsure.fans',
  'https://www.forsure.fans',
];

export function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.lovableproject.com');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
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
