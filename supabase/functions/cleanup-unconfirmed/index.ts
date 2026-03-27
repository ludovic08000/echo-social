import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // List users who haven't confirmed their email after 48 hours
    const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    // Get unconfirmed users from auth.users via admin API
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({
      perPage: 500,
    });

    if (listError) {
      console.error('Error listing users:', listError);
      return new Response(JSON.stringify({ error: 'Failed to list users' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const unconfirmedUsers = (usersData.users || []).filter((u) => {
      // User has no confirmed email
      const notConfirmed = !u.email_confirmed_at;
      // Created more than 48h ago
      const createdAt = new Date(u.created_at);
      const isOld = createdAt < new Date(cutoffDate);
      // Not a bot/system account
      const isNotSystem = u.id !== '00000000-0000-0000-0000-000000000001';

      return notConfirmed && isOld && isNotSystem;
    });

    let deleted = 0;
    const errors: string[] = [];

    for (const user of unconfirmedUsers) {
      try {
        // Clean up profile first
        await supabase.from('profiles').delete().eq('user_id', user.id);

        // Delete the auth user
        const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
        if (deleteError) {
          errors.push(`${user.email}: ${deleteError.message}`);
        } else {
          deleted++;
          console.log(`Deleted unconfirmed account: ${user.email} (created: ${user.created_at})`);
        }
      } catch (err) {
        errors.push(`${user.email}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    console.log(`Cleanup complete: ${deleted} deleted, ${errors.length} errors, ${unconfirmedUsers.length} total unconfirmed`);

    return new Response(
      JSON.stringify({
        success: true,
        total_unconfirmed: unconfirmedUsers.length,
        deleted,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Cleanup error:', error);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
