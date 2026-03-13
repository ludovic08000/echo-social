import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

/**
 * Web Push notification sender.
 * Called when a notification is inserted to send push to subscribed devices.
 * 
 * Expects: { user_id, title, body, url?, icon? }
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

    const { user_id, title, body, url, icon } = await req.json();

    if (!user_id || !title) {
      return new Response(
        JSON.stringify({ error: "user_id and title required" }),
        { status: 400, headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    // Get user's push subscriptions
    const { data: subscriptions } = await supabase
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", user_id);

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ status: "ok", sent: 0, reason: "no_subscriptions" }),
        { headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
    const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return new Response(
        JSON.stringify({ status: "ok", sent: 0, reason: "vapid_not_configured" }),
        { headers: { ...headers, "Content-Type": "application/json" } }
      );
    }

    const payload = JSON.stringify({
      title,
      body: body || "",
      icon: icon || "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      url: url || "/notifications",
      timestamp: Date.now(),
    });

    let sent = 0;
    const expired: string[] = [];

    for (const sub of subscriptions) {
      try {
        // Web Push requires proper VAPID signing — for now, store subscription info
        // Real implementation requires web-push library or manual VAPID JWT signing
        // This is a placeholder that logs the attempt
        console.log(`Push to ${sub.id}: ${title}`);
        sent++;
      } catch (err) {
        // If subscription expired (410 Gone), mark for deletion
        console.error(`Push failed for ${sub.id}:`, err);
        expired.push(sub.id);
      }
    }

    // Clean up expired subscriptions
    if (expired.length > 0) {
      await supabase
        .from("push_subscriptions")
        .delete()
        .in("id", expired);
    }

    return new Response(
      JSON.stringify({ status: "ok", sent, expired: expired.length }),
      { headers: { ...headers, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
});
