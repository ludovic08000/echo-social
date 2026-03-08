import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get old lives to delete their recordings from storage
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

    // Delete recording files from storage
    for (const live of oldLives) {
      if (live.recording_url) {
        const path = live.recording_url.split('/videos/')[1];
        if (path) {
          await supabase.storage.from('videos').remove([path]);
        }
      }
    }

    const ids = oldLives.map(l => l.id);

    // Delete related chat and views
    await supabase.from('live_chat').delete().in('live_id', ids);
    await supabase.from('live_views').delete().in('live_id', ids);

    // Delete the live streams
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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
