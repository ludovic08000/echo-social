import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkRateLimit } from "../_shared/rate-limit.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // Verify JWT from the calling user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify calling user is admin using their JWT
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: callingUser },
    } = await userClient.auth.getUser();
    if (!callingUser) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", callingUser.id)
      .eq("role", "admin")
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: "Accès admin requis" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rateLimited = await checkRateLimit(`admin-delete-user:${callingUser.id}`, 3, 60, corsHeaders);
    if (rateLimited) return rateLimited;

    const { target_user_id } = await req.json();
    if (!target_user_id) {
      return new Response(
        JSON.stringify({ error: "target_user_id requis" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Prevent self-deletion
    if (target_user_id === callingUser.id) {
      return new Response(
        JSON.stringify({ error: "Impossible de supprimer votre propre compte" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Delete user data from all tables
    const tables = [
      "likes",
      "comments",
      "posts",
      "stories",
      "friendships",
      "messages",
      "conversation_participants",
      "notifications",
      "notification_settings",
      "privacy_settings",
      "trust_scores",
      "device_fingerprints",
      "account_deletion_requests",
      "journal_entries",
      "banned_users",
      "content_strikes",
      "abuse_reports",
      "live_streams",
      "cart_items",
      "album_media",
      "albums",
      "anonymous_wall_messages",
      "friend_group_members",
      "friend_groups",
      "group_members",
      "ai_agent_usage",
      "ai_agent_messages",
      "ai_agent_conversations",
      "profiles",
    ];

    for (const table of tables) {
      const col =
        table === "friendships"
          ? "requester_id"
          : table === "abuse_reports"
          ? "reporter_id"
          : "user_id";

      await adminClient.from(table).delete().eq(col, target_user_id);

      // For friendships, also delete where they're the addressee
      if (table === "friendships") {
        await adminClient
          .from("friendships")
          .delete()
          .eq("addressee_id", target_user_id);
      }
      // For abuse_reports, also delete where they're the reported user
      if (table === "abuse_reports") {
        await adminClient
          .from("abuse_reports")
          .delete()
          .eq("reported_user_id", target_user_id);
      }
    }

    // Delete auth user
    const { error: authError } =
      await adminClient.auth.admin.deleteUser(target_user_id);

    if (authError) {
      console.error("Auth deletion error:", authError);
      return new Response(
        JSON.stringify({
          success: true,
          warning: "Données supprimées mais le compte auth n'a pas pu être supprimé",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: "Utilisateur supprimé définitivement" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erreur interne" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
