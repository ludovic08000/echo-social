import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { getCorsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) throw new Error("Not authenticated");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Not authenticated");

    const { type } = await req.json();

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (type === "full") {
      // Full export requires payment — create Stripe checkout
      const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
        apiVersion: "2025-08-27.basil",
      });

      const customers = await stripe.customers.list({ email: user.email!, limit: 1 });
      let customerId: string | undefined;
      if (customers.data.length > 0) customerId = customers.data[0].id;

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        customer_email: customerId ? undefined : user.email!,
        line_items: [{
          price_data: {
            currency: "eur",
            unit_amount: 499,
            product_data: { name: "Export complet ForSure" },
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `${req.headers.get("origin")}/settings?export=success`,
        cancel_url: `${req.headers.get("origin")}/settings?export=cancel`,
        metadata: { user_id: user.id, export_type: "full" },
      });

      return new Response(JSON.stringify({ checkout_url: session.url }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Basic export — free, text data only
    const exportData: Record<string, unknown> = {};

    // Profile
    const { data: profile } = await serviceClient
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    exportData.profile = profile;

    // Posts (text only)
    const { data: posts } = await serviceClient
      .from("posts")
      .select("id, body, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    exportData.posts = posts;

    // Comments
    const { data: comments } = await serviceClient
      .from("comments")
      .select("id, body, post_id, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    exportData.comments = comments;

    // Friends
    const { data: friendships } = await serviceClient
      .from("friendships")
      .select("requester_id, addressee_id, status, created_at")
      .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
      .eq("status", "accepted");
    
    if (friendships) {
      const friendIds = friendships.map(f => 
        f.requester_id === user.id ? f.addressee_id : f.requester_id
      );
      const { data: friendProfiles } = await serviceClient
        .from("profiles")
        .select("name, city")
        .in("user_id", friendIds);
      exportData.friends = friendProfiles;
    }

    // Privacy settings
    const { data: privacy } = await serviceClient
      .from("privacy_settings")
      .select("*")
      .eq("user_id", user.id)
      .single();
    exportData.privacy_settings = privacy;

    // Journal
    const { data: journal } = await serviceClient
      .from("journal_entries")
      .select("title, body, mood, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    exportData.journal = journal;

    exportData.exported_at = new Date().toISOString();
    exportData.user_email = user.email;

    // Return as downloadable JSON
    const jsonStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    return new Response(
      JSON.stringify({
        download_url: `data:application/json;base64,${base64}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("data-export error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
