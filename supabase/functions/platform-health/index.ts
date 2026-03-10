import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Not authenticated");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) throw new Error("Not authenticated");

    // Verify admin
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleData) throw new Error("Admin access required");

    const svc = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { action } = await req.json();
    const report: Record<string, unknown> = {};

    if (action === "full" || action === "duplicates") {
      // ── DUPLICATE DETECTION ──
      // 1. Profiles with same name (potential duplicates)
      // Query profiles directly instead of using execute_sql
      
      // Fallback: query profiles grouped by name
      const { data: allProfiles } = await svc
        .from("profiles")
        .select("user_id, name, avatar_url, city, created_at")
        .order("name");

      const nameGroups: Record<string, any[]> = {};
      for (const p of allProfiles || []) {
        const key = (p.name || "").trim().toLowerCase();
        if (!key) continue;
        if (!nameGroups[key]) nameGroups[key] = [];
        nameGroups[key].push(p);
      }
      const duplicateNames = Object.entries(nameGroups)
        .filter(([, v]) => v.length > 1)
        .map(([name, profiles]) => ({ name, count: profiles.length, profiles }));

      // 2. Multi-account by fingerprint
      const { data: fingerprints } = await svc
        .from("device_fingerprints")
        .select("fingerprint_hash, user_id, user_agent, last_seen_at")
        .order("fingerprint_hash");
      
      const fpGroups: Record<string, any[]> = {};
      for (const fp of fingerprints || []) {
        if (!fpGroups[fp.fingerprint_hash]) fpGroups[fp.fingerprint_hash] = [];
        fpGroups[fp.fingerprint_hash].push(fp);
      }
      const multiAccounts = Object.entries(fpGroups)
        .filter(([, v]) => {
          const uniqueUsers = new Set(v.map(x => x.user_id));
          return uniqueUsers.size > 1;
        })
        .map(([hash, entries]) => ({
          fingerprint: hash.substring(0, 8) + "...",
          user_ids: [...new Set(entries.map(e => e.user_id))],
          count: new Set(entries.map(e => e.user_id)).size,
        }));

      report.duplicates = {
        duplicate_names: duplicateNames.slice(0, 20),
        multi_accounts: multiAccounts.slice(0, 20),
        total_duplicate_name_groups: duplicateNames.length,
        total_multi_account_groups: multiAccounts.length,
      };
    }

    if (action === "full" || action === "coherence") {
      // ── DB COHERENCE ──
      const checks: Array<{ check: string; issues: number; details?: string }> = [];

      // Posts without valid profile
      const { data: posts } = await svc.from("posts").select("user_id");
      const { data: profiles } = await svc.from("profiles").select("user_id");
      const profileIds = new Set((profiles || []).map(p => p.user_id));
      const orphanPosts = (posts || []).filter(p => !profileIds.has(p.user_id));
      checks.push({ check: "Posts sans profil valide", issues: orphanPosts.length });

      // Messages without valid conversation
      const { data: msgs } = await svc.from("messages").select("id, conversation_id");
      const { data: convos } = await svc.from("conversations").select("id");
      const convoIds = new Set((convos || []).map(c => c.id));
      const orphanMsgs = (msgs || []).filter(m => !convoIds.has(m.conversation_id));
      checks.push({ check: "Messages sans conversation", issues: orphanMsgs.length });

      // Comments without valid post
      const { data: comments } = await svc.from("comments").select("id, post_id");
      const postIds = new Set((posts || []).map((p: any) => p.user_id)); // need post ids
      const { data: postsList } = await svc.from("posts").select("id");
      const validPostIds = new Set((postsList || []).map(p => p.id));
      const orphanComments = (comments || []).filter(c => !validPostIds.has(c.post_id));
      checks.push({ check: "Commentaires sans post valide", issues: orphanComments.length });

      // Conversation participants without conversation
      const { data: participants } = await svc.from("conversation_participants").select("id, conversation_id");
      const orphanParticipants = (participants || []).filter(p => !convoIds.has(p.conversation_id));
      checks.push({ check: "Participants sans conversation", issues: orphanParticipants.length });

      // Likes without valid post
      const { data: likes } = await svc.from("likes").select("id, post_id");
      const orphanLikes = (likes || []).filter(l => !validPostIds.has(l.post_id));
      checks.push({ check: "Likes sans post valide", issues: orphanLikes.length });

      // Notifications without valid post
      const { data: notifs } = await svc.from("notifications").select("id, post_id").not("post_id", "is", null);
      const orphanNotifs = (notifs || []).filter(n => n.post_id && !validPostIds.has(n.post_id));
      checks.push({ check: "Notifications avec post supprimé", issues: orphanNotifs.length });

      const totalIssues = checks.reduce((s, c) => s + c.issues, 0);
      report.coherence = { checks, total_issues: totalIssues };
    }

    if (action === "full" || action === "cleanup") {
      // ── AUTO CLEANUP ──
      const cleaned: Array<{ action: string; count: number }> = [];

      // Expired AI cache
      const { data: expiredCache } = await svc
        .from("ai_moderation_cache")
        .select("id")
        .lt("expires_at", new Date().toISOString());
      if (expiredCache && expiredCache.length > 0) {
        await svc.from("ai_moderation_cache").delete().lt("expires_at", new Date().toISOString());
        cleaned.push({ action: "Cache IA expiré supprimé", count: expiredCache.length });
      }

      // Old fingerprints (>365 days) - LCEN requires 12 months retention
      const cutoff365 = new Date(Date.now() - 365 * 86400000).toISOString();
      const { data: oldFP } = await svc
        .from("device_fingerprints")
        .select("id")
        .lt("last_seen_at", cutoff365);
      if (oldFP && oldFP.length > 0) {
        await svc.from("device_fingerprints").delete().lt("last_seen_at", cutoff90);
        cleaned.push({ action: "Empreintes > 90 jours supprimées", count: oldFP.length });
      }

      // Old feed score cache (>7 days)
      const cutoff7 = new Date(Date.now() - 7 * 86400000).toISOString();
      const { data: oldScores } = await svc
        .from("feed_score_cache")
        .select("id")
        .lt("computed_at", cutoff7);
      if (oldScores && oldScores.length > 0) {
        await svc.from("feed_score_cache").delete().lt("computed_at", cutoff7);
        cleaned.push({ action: "Cache feed > 7 jours supprimé", count: oldScores.length });
      }

      // Expired deletion requests (completed)
      const { data: completedDel } = await svc
        .from("account_deletion_requests")
        .select("id")
        .eq("status", "completed");
      if (completedDel && completedDel.length > 0) {
        cleaned.push({ action: "Demandes suppression terminées", count: completedDel.length });
      }

      report.cleanup = {
        actions: cleaned,
        total_cleaned: cleaned.reduce((s, c) => s + c.count, 0),
      };
    }

    if (action === "full" || action === "health") {
      // ── HEALTH REPORT ──
      const tables = [
        "profiles", "posts", "comments", "messages", "likes", "notifications",
        "friendships", "conversations", "products", "orders", "order_items",
        "live_streams", "stories", "albums", "album_media", "groups",
        "abuse_reports", "device_fingerprints", "ai_moderation_cache",
        "feed_score_cache", "trust_scores",
      ];

      const tableCounts: Array<{ table: string; count: number }> = [];
      for (const t of tables) {
        try {
          const { count } = await svc.from(t).select("*", { count: "exact", head: true });
          tableCounts.push({ table: t, count: count || 0 });
        } catch {
          tableCounts.push({ table: t, count: -1 });
        }
      }

      tableCounts.sort((a, b) => b.count - a.count);

      const totalRows = tableCounts.reduce((s, t) => s + Math.max(t.count, 0), 0);

      // Flagged users
      const { count: flaggedCount } = await svc
        .from("trust_scores")
        .select("*", { count: "exact", head: true })
        .eq("is_flagged", true);

      // Pending reports
      const { count: pendingReports } = await svc
        .from("abuse_reports")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

      // Active lives
      const { count: activeLives } = await svc
        .from("live_streams")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true);

      report.health = {
        total_rows: totalRows,
        table_counts: tableCounts,
        flagged_users: flaggedCount || 0,
        pending_reports: pendingReports || 0,
        active_lives: activeLives || 0,
        analyzed_at: new Date().toISOString(),
      };
    }

    return new Response(JSON.stringify(report), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("platform-health error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
