import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ─── Auth check: only admins or service-role can trigger cleanup ───
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Verify caller is an admin
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only admins can run cleanup
    const { data: roleCheck } = await supabase
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleCheck) {
      return new Response(JSON.stringify({ error: "Accès refusé" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: oldLives } = await supabase
      .from('live_streams')
      .select('id, recording_url, user_id')
      .eq('is_active', false)
      .not('ended_at', 'is', null)
      .lt('ended_at', thirtyDaysAgo.toISOString());

    if (!oldLives || oldLives.length === 0) {
      return new Response(JSON.stringify({ deleted: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    for (const live of oldLives) {
      if (live.recording_url) {
        const path = live.recording_url.split('/videos/')[1];
        if (path) {
          await supabase.storage.from('videos').remove([path]);
        }
      }
    }

    const ids = oldLives.map(l => l.id);
    await supabase.from('live_chat').delete().in('live_id', ids);
    await supabase.from('live_views').delete().in('live_id', ids);

    const { error } = await supabase
      .from('live_streams')
      .delete()
      .in('id', ids);

    if (error) throw error;

    console.log(`Cleaned up ${ids.length} old live streams`);

    return new Response(JSON.stringify({ deleted: ids.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Cleanup error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
