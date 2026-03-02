import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Compute trust score for a user based on multiple signals
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
}): {
  trustScore: number;
  transactionScore: number;
  socialScore: number;
  accountAgeScore: number;
  verificationScore: number;
} {
  // 1. Account age score (0-20)
  const accountAgeScore = Math.min(20, Math.floor(data.accountAgeDays / 15));

  // 2. Transaction score (0-40)
  const totalTransactions = data.successfulSales + data.successfulPurchases;
  let transactionScore = Math.min(25, totalTransactions * 2);

  // Penalty for disputes
  if (data.disputesLost > 0) {
    transactionScore -= data.disputesLost * 5;
  }
  if (data.disputesOpened > totalTransactions * 0.3 && totalTransactions > 3) {
    transactionScore -= 10; // Too many disputes relative to transactions
  }

  // Seller rating bonus
  if (data.sellerRating && data.sellerRatingCount >= 3) {
    transactionScore += Math.floor((data.sellerRating / 5) * 15);
  }
  transactionScore = Math.max(0, Math.min(40, transactionScore));

  // 3. Social score (0-20)
  let socialScore = Math.min(15, Math.floor(data.friendCount / 5));
  // Penalty for confirmed reports
  if (data.reportsConfirmed > 0) {
    socialScore -= data.reportsConfirmed * 5;
  }
  socialScore = Math.max(0, Math.min(20, socialScore));

  // 4. Verification score (0-20)
  let verificationScore = 0;
  if (data.isVerifiedIdentity) verificationScore += 20;

  // Composite
  const trustScore = Math.max(
    0,
    Math.min(
      100,
      accountAgeScore + transactionScore + socialScore + verificationScore
    )
  );

  return {
    trustScore,
    transactionScore,
    socialScore,
    accountAgeScore,
    verificationScore,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { action, userId } = body;

    if (action === "compute" && userId) {
      // Get profile for account age
      const { data: profile } = await supabase
        .from("profiles")
        .select("created_at")
        .eq("user_id", userId)
        .single();

      const accountAgeDays = profile
        ? Math.floor(
            (Date.now() - new Date(profile.created_at).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        : 0;

      // Get existing trust data
      const { data: existing } = await supabase
        .from("trust_scores")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      // Get seller profile stats
      const { data: seller } = await supabase
        .from("seller_profiles")
        .select("rating_average, rating_count, total_sales")
        .eq("user_id", userId)
        .maybeSingle();

      // Count friends
      const { count: friendCount } = await supabase
        .from("friendships")
        .select("id", { count: "exact", head: true })
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .eq("status", "accepted");

      // Count reports
      const { count: reportsReceived } = await supabase
        .from("abuse_reports")
        .select("id", { count: "exact", head: true })
        .eq("reported_user_id", userId);

      const { count: reportsConfirmed } = await supabase
        .from("abuse_reports")
        .select("id", { count: "exact", head: true })
        .eq("reported_user_id", userId)
        .eq("status", "confirmed");

      const scores = computeTrustScore({
        accountAgeDays,
        successfulSales: seller?.total_sales || 0,
        successfulPurchases: existing?.successful_purchases || 0,
        disputesOpened: existing?.disputes_opened || 0,
        disputesLost: existing?.disputes_lost || 0,
        reportsReceived: reportsReceived || 0,
        reportsConfirmed: reportsConfirmed || 0,
        isVerifiedIdentity: existing?.is_verified_identity || false,
        sellerRating: seller?.rating_average,
        sellerRatingCount: seller?.rating_count || 0,
        friendCount: friendCount || 0,
      });

      // Upsert trust score
      const { data: result, error } = await supabase
        .from("trust_scores")
        .upsert(
          {
            user_id: userId,
            ...scores,
            successful_sales: seller?.total_sales || 0,
            reports_received: reportsReceived || 0,
            reports_confirmed: reportsConfirmed || 0,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        )
        .select()
        .single();

      if (error) throw error;

      return new Response(JSON.stringify({ trustScore: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "get" && userId) {
      const { data, error } = await supabase
        .from("trust_scores")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) throw error;
      return new Response(JSON.stringify({ trustScore: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'compute' or 'get'" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
