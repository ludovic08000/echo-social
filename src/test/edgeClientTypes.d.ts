// Type-only compatibility for importing pure Edge helpers in local tests.
// At deployment Deno resolves the URL; tests use the same installed JS client.
declare module 'https://esm.sh/@supabase/supabase-js@2' {
  export type { SupabaseClient } from '@supabase/supabase-js';
}
