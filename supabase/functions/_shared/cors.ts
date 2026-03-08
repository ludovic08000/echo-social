// Allowed origins for CORS - restrict to actual app domains
const ALLOWED_ORIGINS = [
  'https://calm-connect-05.lovable.app',
  'https://id-preview--14bf9f2a-b211-4bff-8f3c-1cd3d8a0a907.lovable.app',
];

export function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || '';
  // Allow lovable preview/project domains dynamically
  const isAllowed = ALLOWED_ORIGINS.includes(origin) 
    || origin.endsWith('.lovable.app') 
    || origin.endsWith('.lovableproject.com');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
    'Vary': 'Origin',
  };
}

// Legacy export for backwards compatibility
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};
