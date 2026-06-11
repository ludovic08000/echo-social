import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

/**
 * Scheduled data cleanup function.
 * Removes expired posts, old notifications, stale feed cache,
 * and old AI moderation cache entries.
 * Should be called via pg_cron every hour.
 */
Deno.serve(async (req) => {
  const headers = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const now = new Date().toISOString();
    const results: Record<string, number> = {};

    // 1. Delete expired posts
    const { data: expiredPosts } = await supabase
      .from("posts")
      .delete()
      .lt("expires_at", now)
      .not("expires_at", "is", null)
      .select("id");
    results.expired_posts = expiredPosts?.length || 0;

    // 2. Delete old notifications (> 90 days)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString();
    const { data: oldNotifs } = await supabase
      .from("notifications")
      .delete()
      .lt("created_at", ninetyDaysAgo)
      .select("id");
    results.old_notifications = oldNotifs?.length || 0;

    // 3. Clean stale user_feed entries (> 7 days old)
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: staleFeed } = await supabase
      .from("user_feed")
      .delete()
      .lt("inserted_at", sevenDaysAgo)
      .select("id");
    results.stale_feed_entries = staleFeed?.length || 0;

    // 4. Clean expired AI moderation cache
    await supabase.rpc("cleanup_ai_cache");
    results.ai_cache_cleaned = 1;

    // 5. Clean old feed performance metrics (> 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data: oldMetrics } = await supabase
      .from("feed_performance_metrics")
      .delete()
      .lt("created_at", thirtyDaysAgo)
      .select("id");
    results.old_metrics = oldMetrics?.length || 0;

    // 6. Clean old feed score cache (> 24h)
    const oneDayAgo = new Date(Date.now() - 86400_000).toISOString();
    const { data: oldScores } = await supabase
      .from("feed_score_cache")
      .delete()
      .lt("computed_at", oneDayAgo)
      .select("id");
    results.old_score_cache = oldScores?.length || 0;

    // 7. Clean old device fingerprints
    await supabase.rpc("cleanup_old_fingerprints");
    results.fingerprints_cleaned = 1;

    // 8. Purge audit logs older than 6 months (RGPD/CNIL compliance)
    await supabase.rpc("purge_old_audit_logs");
    results.audit_logs_purged = 1;

    // 9. Disappearing messages — purge expired chat messages (Lot A1)
    const { data: expiredMsgs } = await supabase
      .from("messages")
      .delete()
      .lt("expires_at", now)
      .not("expires_at", "is", null)
      .select("id");
    results.expired_messages = expiredMsgs?.length || 0;

    // 10. Stories — defensive purge of expired stories (cron safety net)
    const { data: expiredStories } = await supabase
      .from("stories")
      .delete()
      .lt("expires_at", now)
      .select("id");
    results.expired_stories = expiredStories?.length || 0;

    console.log("Cleanup results:", results);

    return new Response(
      JSON.stringify({ status: "ok", cleaned: results, timestamp: now }),
      { headers: { ...headers, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Cleanup error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
});
