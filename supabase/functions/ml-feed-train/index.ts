// ML Feed trainer: hourly job that learns user preferences and post features
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getCorsHeaders } from "../_shared/cors.ts";

function isAuthorizedTrainingRun(req: Request): boolean {
  const secret = Deno.env.get("ML_TRAIN_SECRET") || Deno.env.get("CRON_SECRET");
  const provided = req.headers.get("x-ml-train-secret") || req.headers.get("x-cron-secret");
  return !!secret && provided === secret;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

interface InteractionRow {
  user_id: string;
  post_id: string;
  signal_type: string;
  weight: number;
  dwell_ms: number | null;
  hour_of_day: number;
  day_of_week: number;
  created_at: string;
}

interface PostRow {
  id: string;
  user_id: string;
  body: string | null;
  image_url: string | null;
  created_at: string;
  likes_count: number;
  comments_count: number;
}

// Decay weight by age in days (half-life)
function decay(createdAt: string, halfLifeDays: number): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// Generate a 768-dim semantic embedding via Gemini text-embedding-004
async function generateEmbedding(text: string): Promise<number[] | null> {
  const clean = (text || "").slice(0, 2000).trim();
  if (!clean || clean.length < 5) return null;
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/text-embedding-004",
        input: clean,
      }),
    });
    if (!resp.ok) {
      console.error("embedding HTTP error:", resp.status, await resp.text().catch(() => ""));
      return null;
    }
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    if (Array.isArray(emb) && emb.length === 768) return emb;
    return null;
  } catch (e) {
    console.error("generateEmbedding error:", e);
    return null;
  }
}

// Convert a JS number array into the pgvector text format: "[0.1,0.2,...]"
function toPgVector(arr: number[]): string {
  return "[" + arr.map((n) => Number(n.toFixed(6))).join(",") + "]";
}

// Average several embeddings into a single vector (weighted)
function averageEmbeddings(items: { emb: number[]; weight: number }[]): number[] | null {
  if (!items.length) return null;
  const dim = items[0].emb.length;
  const out = new Array(dim).fill(0);
  let totalW = 0;
  for (const { emb, weight } of items) {
    if (emb.length !== dim) continue;
    const w = Math.max(0, weight);
    if (w === 0) continue;
    for (let i = 0; i < dim; i++) out[i] += emb[i] * w;
    totalW += w;
  }
  if (totalW === 0) return null;
  // Normalize to unit length (cosine-friendly)
  for (let i = 0; i < dim; i++) out[i] /= totalW;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) out[i] /= norm;
  return out;
}

// Extract topics + hashtags from post body using Lovable AI
async function extractFeatures(post: PostRow): Promise<{ topics: string[]; hashtags: string[]; sentiment: number; quality: number; language: string }> {
  const text = (post.body || "").slice(0, 1500);
  const fallback = {
    topics: [] as string[],
    hashtags: (text.match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase().replace("#", "")).slice(0, 10),
    sentiment: 0,
    quality: post.image_url ? 0.6 : 0.5,
    language: "und",
  };

  if (!text || text.length < 10) return fallback;

  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: "Extract feed post features. Return ONLY via the function." },
          { role: "user", content: text },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_features",
              description: "Extract topics, hashtags, sentiment, quality, language",
              parameters: {
                type: "object",
                properties: {
                  topics: { type: "array", items: { type: "string" }, description: "3-5 broad topic tags lowercase (e.g. tech, sport, food, music, politics, humour)" },
                  hashtags: { type: "array", items: { type: "string" }, description: "Hashtags without #" },
                  sentiment: { type: "number", description: "-1 (negative) to 1 (positive)" },
                  quality: { type: "number", description: "0 (low) to 1 (high) editorial quality" },
                  language: { type: "string", description: "ISO 639-1 code (fr, en, es, de, ...)" },
                },
                required: ["topics", "hashtags", "sentiment", "quality", "language"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_features" } },
      }),
    });

    if (!resp.ok) return fallback;
    const data = await resp.json();
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return fallback;
    const parsed = JSON.parse(args);
    return {
      topics: (parsed.topics || []).map((t: string) => t.toLowerCase()).slice(0, 8),
      hashtags: [...new Set([...(parsed.hashtags || []), ...fallback.hashtags])].slice(0, 12),
      sentiment: Math.max(-1, Math.min(1, Number(parsed.sentiment) || 0)),
      quality: Math.max(0, Math.min(1, Number(parsed.quality) || 0.5)),
      language: parsed.language || "und",
    };
  } catch (e) {
    console.error("extractFeatures error:", e);
    return fallback;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!isAuthorizedTrainingRun(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const startedAt = Date.now();

  // Insert run record
  const { data: runRow } = await supabase
    .from("ml_model_runs")
    .insert({ run_type: "hourly", status: "running" })
    .select()
    .single();
  const runId = runRow?.id;

  try {
    // Load config
    const { data: configRows } = await supabase.from("ml_model_config").select("key, value");
    const config: Record<string, any> = {};
    (configRows || []).forEach((r) => (config[r.key] = r.value));
    const halfLife = Number(config.decay_half_life_days) || 7;
    const signalW: Record<string, number> = config.signal_weights || {};

    // 1) Fetch recent interactions (last 14 days)
    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: interactions } = await supabase
      .from("ml_interactions")
      .select("user_id, post_id, signal_type, weight, dwell_ms, hour_of_day, day_of_week, created_at")
      .gte("created_at", since)
      .limit(50000);
    const allInter = (interactions || []) as InteractionRow[];

    // 2) Fetch recent posts (last 30 days, what feed will surface)
    const postsSince = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: posts } = await supabase
      .from("posts")
      .select("id, user_id, body, image_url, created_at, likes_count, comments_count")
      .gte("created_at", postsSince)
      .order("created_at", { ascending: false })
      .limit(2000);
    const allPosts = (posts || []) as PostRow[];

    // 3) Extract features for posts that don't have them yet (cap to 60 per run for cost).
    // Single-batch fetch — avoids N+1 queries later in the user-profile build phase.
    const { data: existing } = await supabase
      .from("ml_post_features")
      .select("post_id, topics, hashtags, embedding")
      .in("post_id", allPosts.map((p) => p.id));
    const existingMap = new Map<string, { topics: string[]; hashtags: string[]; embedding: any }>();
    for (const r of existing || []) {
      existingMap.set((r as any).post_id, {
        topics: (r as any).topics || [],
        hashtags: (r as any).hashtags || [],
        embedding: (r as any).embedding ?? null,
      });
    }
    const existingIds = new Set(existingMap.keys());
    const toExtract = allPosts.filter((p) => !existingIds.has(p.id)).slice(0, 60);

    let postsProcessed = 0;
    const postEmbeddings = new Map<string, number[]>();
    // Cache for freshly extracted features so we can build the user-profile phase without re-querying
    const freshFeatures = new Map<string, { topics: string[]; hashtags: string[] }>();

    // Batch AI extraction (5 posts in parallel) — keeps cost bounded but ~5x faster than serial
    const EXTRACT_CONCURRENCY = 5;
    for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
      const chunk = toExtract.slice(i, i + EXTRACT_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (post) => {
        const f = await extractFeatures(post);
        const embText = [
          post.body || "",
          f.topics.join(" "),
          f.hashtags.map((h) => "#" + h).join(" "),
        ].filter(Boolean).join("\n").slice(0, 2000);
        const emb = await generateEmbedding(embText);
        return { post, f, emb };
      }));

      for (const { post, f, emb } of results) {
        if (emb) postEmbeddings.set(post.id, emb);
        freshFeatures.set(post.id, { topics: f.topics, hashtags: f.hashtags });
        await supabase.from("ml_post_features").upsert({
          post_id: post.id,
          topics: f.topics,
          hashtags: f.hashtags,
          sentiment: f.sentiment,
          quality_score: f.quality,
          language: f.language,
          has_media: !!post.image_url,
          engagement_velocity: 0,
          ctr: 0,
          view_count: 0,
          positive_count: 0,
          negative_count: 0,
          ...(emb ? { embedding: toPgVector(emb), embedding_updated_at: new Date().toISOString() } : {}),
        });
        postsProcessed++;
      }
    }

    // Also load existing embeddings into the postEmbeddings map (already fetched above — no extra query)
    for (const [pid, row] of existingMap) {
      const e = row.embedding;
      if (typeof e === "string") {
        try {
          const arr = JSON.parse(e);
          if (Array.isArray(arr)) postEmbeddings.set(pid, arr);
        } catch {}
      } else if (Array.isArray(e)) {
        postEmbeddings.set(pid, e);
      }
    }

    // 4) Update CTR & velocity for ALL posts with features (cheap aggregation)
    const postInteractions = new Map<string, { views: number; pos: number; neg: number }>();
    for (const it of allInter) {
      const cur = postInteractions.get(it.post_id) || { views: 0, pos: 0, neg: 0 };
      const w = signalW[it.signal_type] ?? it.weight ?? 1;
      if (it.signal_type === "view") cur.views++;
      if (w > 0.5) cur.pos++;
      if (w < 0) cur.neg++;
      postInteractions.set(it.post_id, cur);
    }
    // Parallelize CTR updates (10 at a time) instead of awaiting one-by-one
    const ctrEntries = Array.from(postInteractions.entries());
    const CTR_CONCURRENCY = 10;
    for (let i = 0; i < ctrEntries.length; i += CTR_CONCURRENCY) {
      const chunk = ctrEntries.slice(i, i + CTR_CONCURRENCY);
      await Promise.all(chunk.map(([postId, agg]) => {
        const ctr = agg.views > 0 ? agg.pos / agg.views : 0;
        return supabase
          .from("ml_post_features")
          .update({
            view_count: agg.views,
            positive_count: agg.pos,
            negative_count: agg.neg,
            ctr: Number(ctr.toFixed(4)),
            engagement_velocity: agg.pos + agg.neg,
          })
          .eq("post_id", postId);
      }));
    }

    // 5) Build per-user preference profiles — read features from in-memory cache (no N+1 query)
    const postFeatureMap = new Map<string, { topics: string[]; hashtags: string[]; author: string }>();
    for (const p of allPosts) {
      const cached = freshFeatures.get(p.id) || existingMap.get(p.id);
      postFeatureMap.set(p.id, {
        topics: cached?.topics || [],
        hashtags: cached?.hashtags || [],
        author: p.user_id,
      });
    }

    const userAgg = new Map<string, {
      topics: Record<string, number>;
      hashtags: Record<string, number>;
      authors: Record<string, number>;
      hours: Record<string, number>;
      days: Record<string, number>;
      dwellSum: number;
      dwellCount: number;
      total: number;
      embItems: { emb: number[]; weight: number }[];
    }>();

    for (const it of allInter) {
      const feat = postFeatureMap.get(it.post_id);
      if (!feat) continue;
      const w = (signalW[it.signal_type] ?? it.weight ?? 1) * decay(it.created_at, halfLife);
      const u = userAgg.get(it.user_id) || {
        topics: {}, hashtags: {}, authors: {}, hours: {}, days: {},
        dwellSum: 0, dwellCount: 0, total: 0, embItems: [],
      };
      for (const t of feat.topics) u.topics[t] = (u.topics[t] || 0) + w;
      for (const h of feat.hashtags) u.hashtags[h] = (u.hashtags[h] || 0) + w * 0.5;
      u.authors[feat.author] = (u.authors[feat.author] || 0) + w;
      u.hours[String(it.hour_of_day)] = (u.hours[String(it.hour_of_day)] || 0) + Math.max(0, w);
      u.days[String(it.day_of_week)] = (u.days[String(it.day_of_week)] || 0) + Math.max(0, w);
      if (it.dwell_ms) {
        u.dwellSum += it.dwell_ms;
        u.dwellCount++;
      }
      // Capture post embedding for positive signals only (likes, comments, dwell, share)
      if (w > 0.5) {
        const postEmb = postEmbeddings.get(it.post_id);
        if (postEmb) u.embItems.push({ emb: postEmb, weight: w });
      }
      u.total++;
      userAgg.set(it.user_id, u);
    }

    // Normalize and persist profiles
    const normalize = (obj: Record<string, number>): Record<string, number> => {
      const max = Math.max(0.0001, ...Object.values(obj));
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = Number((v / max).toFixed(3));
      return out;
    };

    let usersProcessed = 0;
    let usersWithEmbedding = 0;
    for (const [userId, u] of userAgg) {
      const userEmb = averageEmbeddings(u.embItems);
      if (userEmb) usersWithEmbedding++;
      await supabase.from("ml_user_profiles").upsert({
        user_id: userId,
        topic_weights: normalize(u.topics),
        hashtag_weights: normalize(u.hashtags),
        author_affinity: normalize(u.authors),
        hourly_activity: normalize(u.hours),
        daily_activity: normalize(u.days),
        avg_session_dwell_ms: u.dwellCount > 0 ? Math.round(u.dwellSum / u.dwellCount) : 0,
        total_interactions: u.total,
        last_trained_at: new Date().toISOString(),
        ...(userEmb ? { embedding: toPgVector(userEmb), embedding_updated_at: new Date().toISOString() } : {}),
      });
      usersProcessed++;
    }

    // 6) Compute global metrics
    const totalViews = allInter.filter((i) => i.signal_type === "view").length;
    const totalPositive = allInter.filter((i) => (signalW[i.signal_type] ?? 0) >= 1).length;
    const globalCTR = totalViews > 0 ? totalPositive / totalViews : 0;

    await supabase
      .from("ml_model_runs")
      .update({
        status: "success",
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        users_processed: usersProcessed,
        posts_processed: postsProcessed,
        interactions_analyzed: allInter.length,
        metrics: {
          global_ctr: Number(globalCTR.toFixed(4)),
          total_users_with_profiles: usersProcessed,
          total_posts_with_features: postsProcessed + existingIds.size,
          avg_dwell_ms: 0,
          users_with_embedding: usersWithEmbedding,
          posts_with_new_embedding: postEmbeddings.size,
        },
      })
      .eq("id", runId);

    return new Response(
      JSON.stringify({
        ok: true,
        run_id: runId,
        users_processed: usersProcessed,
        posts_processed: postsProcessed,
        interactions: allInter.length,
        global_ctr: globalCTR,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("ml-feed-train error:", e);
    await supabase
      .from("ml_model_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        error_message: e instanceof Error ? e.message : String(e),
      })
      .eq("id", runId);
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
