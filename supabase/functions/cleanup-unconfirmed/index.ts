import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { requireAdmin, requireCronSecret } from '../_shared/auth-guard.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if(req.method!=='POST') return new Response(null,{status:405,headers:{...corsHeaders,Allow:'POST'}});
  const cron=requireCronSecret(req,corsHeaders);
  if(!cron.ok){const admin=await requireAdmin(req,corsHeaders);if(!admin.ok)return admin.response;}

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const candidates: { user_id: string; created_at: string }[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let complete = false;
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 500 });
      if (error || !Array.isArray(data?.users)) throw new Error('ACCOUNT_INVENTORY_UNAVAILABLE');
      scanned += data.users.length;
      for (const user of data.users) {
        if (!user.id || seen.has(user.id)) continue;
        seen.add(user.id);
        // Une connexion OAuth/téléphone n'est pas un compte abandonné faute d'e-mail confirmé.
        if (user.email_confirmed_at || user.confirmed_at || user.phone_confirmed_at || user.last_sign_in_at || user.deleted_at ||
          user.id === '00000000-0000-0000-0000-000000000001' || !(Date.parse(user.created_at) < cutoff)) continue;
        const { data: fresh, error: readError } = await supabase.auth.admin.getUserById(user.id);
        if (readError || !fresh?.user) throw new Error('ACCOUNT_RECHECK_UNAVAILABLE');
        const current = fresh.user;
        if (current.id !== user.id || current.email_confirmed_at || current.confirmed_at || current.phone_confirmed_at ||
          current.last_sign_in_at || current.deleted_at || !(Date.parse(current.created_at) < cutoff)) continue;
        candidates.push({ user_id: current.id, created_at: current.created_at });
      }
      if (data.users.length < 500) { complete = true; break; }
    }
    // L'API Auth ne propose pas de suppression conditionnelle atomique sur la confirmation.
    // Un « recheck puis delete » garde une course avec le clic du mail : inventaire uniquement,
    // sans effacer profil/compte ni annoncer qu'un nettoyage destructif a réussi.
    console.log('Unconfirmed account review', { scanned, candidates: candidates.length, complete });

    return new Response(
      JSON.stringify({
        success: true, mode: 'review_only', deletion_enabled: false,
        scanned, complete, total_unconfirmed: candidates.length, candidates, deleted: 0,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Unconfirmed account review unavailable');
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
