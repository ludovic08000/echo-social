import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { cached, invalidateCache } from "../_shared/edge-cache.ts";

function computeTrustScore(data: {
  accountAgeDays: number;
  successfulSales: number;
  successfulPurchases: number;
  disputesOpened: number;
  disputesLost: number;
  reportsReceived: number;
  reportsConfirmed: number;
  isVerifiedIdentity: boolean;
  sellerRating: number | null;
  sellerRatingCount: number;
  friendCount: number;
}) {
  const accountAgeScore = Math.min(20, Math.floor(data.accountAgeDays / 15));

  const totalTransactions = data.successfulSales + data.successfulPurchases;
  let transactionScore = Math.min(25, totalTransactions * 2);
  if (data.disputesLost > 0) transactionScore -= data.disputesLost * 5;
  if (data.disputesOpened > totalTransactions * 0.3 && totalTransactions > 3) transactionScore -= 10;
  if (data.sellerRating && data.sellerRatingCount >= 3) {
    transactionScore += Math.floor((data.sellerRating / 5) * 15);
  }
  transactionScore = Math.max(0, Math.min(40, transactionScore));

  let socialScore = Math.min(15, Math.floor(data.friendCount / 5));
  if (data.reportsConfirmed > 0) socialScore -= data.reportsConfirmed * 5;
  socialScore = Math.max(0, Math.min(20, socialScore));

  let verificationScore = 0;
  if (data.isVerifiedIdentity) verificationScore += 20;

  const trustScore = Math.max(0, Math.min(100, accountAgeScore + transactionScore + socialScore + verificationScore));
  return { trustScore, transactionScore, socialScore, accountAgeScore, verificationScore };
}

// ─── Reusable service-role client ───
let _supabase: ReturnType<typeof createClient> | null = null;
function getServiceClient() {
  if (!_supabase) {
    _supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
  }
  return _supabase;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = getServiceClient();

    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims?.sub) {
      return new Response(JSON.stringify({ error: "Non authentifié" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const body = await req.json();
    const { action } = body;

    if (action === "get") {
      // Cache trust score 3 minutes per user
      const data = await cached(`trust:${userId}`, 180_000, async () => {
        const { data, error } = await supabase
          .from("trust_scores")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        if (error) throw error;
        return data;
      });

      return new Response(JSON.stringify({ trustScore: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "compute") {
      // ── PARALLEL: fetch all data in one shot instead of sequential queries ──
      const [profileRes, existingRes, sellerRes, friendCountRes, reportsReceivedRes, reportsConfirmedRes] =
        await Promise.all([
          supabase.from("profiles").select("created_at").eq("user_id", userId).single(),
          supabase.from("trust_scores").select("*").eq("user_id", userId).maybeSingle(),
          supabase.from("seller_profiles").select("rating_average, rating_count, total_sales").eq("user_id", userId).maybeSingle(),
          supabase.from("friendships").select("id", { count: "exact", head: true })
            .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`).eq("status", "accepted"),
          supabase.from("abuse_reports").select("id", { count: "exact", head: true }).eq("reported_user_id", userId),
          supabase.from("abuse_reports").select("id", { count: "exact", head: true })
            .eq("reported_user_id", userId).eq("status", "confirmed"),
        ]);

      const profile = profileRes.data;
      const existing = existingRes.data;
      const seller = sellerRes.data;

      const accountAgeDays = profile
        ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      const scores = computeTrustScore({
        accountAgeDays,
        successfulSales: seller?.total_sales || 0,
        successfulPurchases: existing?.successful_purchases || 0,
        disputesOpened: existing?.disputes_opened || 0,
        disputesLost: existing?.disputes_lost || 0,
        reportsReceived: reportsReceivedRes.count || 0,
        reportsConfirmed: reportsConfirmedRes.count || 0,
        isVerifiedIdentity: existing?.is_verified_identity || false,
        sellerRating: seller?.rating_average,
        sellerRatingCount: seller?.rating_count || 0,
        friendCount: friendCountRes.count || 0,
      });

      const { data: result, error } = await supabase
        .from("trust_scores")
        .upsert({
          user_id: userId,
          trust_score: scores.trustScore,
          transaction_score: scores.transactionScore,
          social_score: scores.socialScore,
          account_age_score: scores.accountAgeScore,
          verification_score: scores.verificationScore,
          successful_sales: seller?.total_sales || 0,
          reports_received: reportsReceivedRes.count || 0,
          reports_confirmed: reportsConfirmedRes.count || 0,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" })
        .select()
        .single();

      if (error) throw error;

      // Invalidate cached trust score & global trust scores cache
      invalidateCache(`trust:${userId}`);
      invalidateCache("trust_scores:all");

      return new Response(JSON.stringify({ trustScore: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'compute' or 'get'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
