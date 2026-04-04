import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { getCorsHeaders } from "../_shared/cors.ts";

// Strict phone validation: E.164 format
function normalizePhone(raw: string): string | null {
  let clean = raw.replace(/[\s\-().]/g, '');
  
  // French local → international
  if (clean.startsWith('0') && clean.length === 10) {
    clean = '+33' + clean.slice(1);
  }
  if (!clean.startsWith('+')) {
    clean = '+' + clean;
  }
  
  // E.164: + followed by 7-15 digits
  const e164 = /^\+[1-9]\d{6,14}$/;
  if (!e164.test(clean)) return null;
  
  return clean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { phone_number } = await req.json();

    if (!phone_number || typeof phone_number !== 'string') {
      return new Response(JSON.stringify({ error: 'Numéro requis' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Limit raw input length
    if (phone_number.length > 25) {
      return new Response(JSON.stringify({ error: 'Numéro trop long' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalized = normalizePhone(phone_number);
    if (!normalized) {
      return new Response(JSON.stringify({ error: 'Format de numéro invalide' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use service role to update (bypasses RLS for controlled write)
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { error: updateError } = await adminClient
      .from('profiles')
      .update({ phone_number: normalized })
      .eq('user_id', user.id);

    if (updateError) {
      return new Response(JSON.stringify({ error: 'Erreur de sauvegarde' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, phone_number: normalized }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Erreur serveur' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
