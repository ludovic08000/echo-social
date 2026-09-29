// ML Feed trainer: hourly job that learns user preferences and post features
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  evaluateMmrShadow,
  parsePgVector,
  semanticMmrRerank,
  type MmrEvaluation,
  type SemanticCandidate,
} from "../_shared/semantic-mmr.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const EMBEDDING_MODEL = "google/gemini-embedding-2";
const EMBEDDING_DIMENSION = 768;
const FEATURE_MODEL = "google/gemini-3.1-flash-lite";
const AI_REQUEST_TIMEOUT_MS = 8_000;
const STALE_RUN_AFTER_MS = 5 * 60_000;

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

// Generate a batch of 768-dimensional semantic embeddings. The Lovable AI
// gateway returns 3072 dimensions by default for Gemini Embedding 2, so the
// explicit dimensions parameter is part of the storage contract.
async function generateEmbeddingBatch(texts: string[]): Promise<Array<number[] | null>> {
  const output = new Array<number[] | null>(texts.length).fill(null);
  const active = texts
    .map((text, index) => ({ index, text: (text || "").slice(0, 2000).trim() }))
    .filter(({ text }) => text.length >= 5);
  if (active.length === 0) return output;

  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: active.map(({ text }) => text),
        dimensions: EMBEDDING_DIMENSION,
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.error("embedding HTTP error:", resp.status, await resp.text().catch(() => ""));
      return output;
    }
    const data = await resp.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    rows.forEach((row: { index?: number; embedding?: unknown }, responseIndex: number) => {
      const activeIndex = Number.isInteger(row?.index) ? Number(row.index) : responseIndex;
      const originalIndex = active[activeIndex]?.index;
      const embedding = row?.embedding;
      if (
        originalIndex !== undefined
        && Array.isArray(embedding)
        && embedding.length === EMBEDDING_DIMENSION
        && embedding.every((value: unknown) => Number.isFinite(Number(value)))
      ) {
        output[originalIndex] = embedding.map(Number);
      }
    });
    return output;
  } catch (e) {
    console.error("generateEmbeddingBatch error:", e);
    return output;
  }
}

// Convert a JS number array into the pgvector text format: "[0.1,0.2,...]"
function toPgVector(arr: number[]): string {
  return "[" + arr.map((n) => Number(n.toFixed(6))).join(",") + "]";
}

// Deterministically fold the 768d semantic vector into a normalized 256d
// cold-start vector. A trained two-tower vector always wins and is never
// overwritten by this seed.
function foldSemanticEmbedding(embedding: number[]): number[] | null {
  if (embedding.length !== 768 || embedding.some((value) => !Number.isFinite(value))) return null;
  const folded = new Array(256).fill(0).map((_, index) => (
    embedding[index] + embedding[index + 256] + embedding[index + 512]
  ));
  const norm = Math.sqrt(folded.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return null;
  return folded.map((value) => value / norm);
}

function averageMetric(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
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
        model: FEATURE_MODEL,
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
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth: admin user OR service-role / cron call only
  const { requireAdmin } = await import("../_shared/auth-guard.ts");
  const guard = await requireAdmin(req, corsHeaders);
  if (!("userId" in guard)) return guard.response;

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const startedAt = Date.now();

  // Recover invocations that were terminated by the Edge runtime before they
  // could close their run row, then avoid overlapping healthy hourly runs.
  const staleCutoff = new Date(startedAt - STALE_RUN_AFTER_MS).toISOString();
  await supabase
    .from("ml_model_runs")
    .update({
      status: "failed",
      completed_at: new Date(startedAt).toISOString(),
      error_message: "Recovered stale hourly feed run before starting a replacement",
    })
    .eq("run_type", "hourly")
    .eq("status", "running")
    .lt("started_at", staleCutoff);

  const { data: activeRun } = await supabase
    .from("ml_model_runs")
    .select("id, started_at")
    .eq("run_type", "hourly")
    .eq("status", "running")
    .gte("started_at", staleCutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeRun) {
    return new Response(JSON.stringify({
      ok: true,
      skipped: "RUN_ALREADY_ACTIVE",
      active_run_id: activeRun.id,
    }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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

    // 2) Fetch every active post. The previous 30-day window permanently
    // stranded older active posts without semantic features or embeddings.
    const { data: posts } = await supabase
      .from("posts")
      .select("id, user_id, body, image_url, created_at, likes_count, comments_count")
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order("created_at", { ascending: false })
      .limit(2000);
    const allPosts = (posts || []) as PostRow[];

    // 3) Fill missing feature rows AND rows whose semantic embedding is null.
    // This is deliberately capped to keep Lovable AI cost and runtime bounded.
    let existing: any[] = [];
    if (allPosts.length > 0) {
      const existingResult = await supabase
        .from("ml_post_features")
        .select("post_id, topics, hashtags, sentiment, quality_score, language, embedding, embedding_text")
        .in("post_id", allPosts.map((p) => p.id));
      if (existingResult.error) throw existingResult.error;
      existing = existingResult.data || [];
    }
    type CachedFeature = {
      topics: string[];
      hashtags: string[];
      sentiment: number;
      quality: number;
      language: string;
      embedding: unknown;
      embeddingText: string;
    };
    const existingMap = new Map<string, CachedFeature>();
    for (const r of existing || []) {
      existingMap.set((r as any).post_id, {
        topics: (r as any).topics || [],
        hashtags: (r as any).hashtags || [],
        sentiment: Number((r as any).sentiment) || 0,
        quality: Number((r as any).quality_score) || 0.5,
        language: (r as any).language || "und",
        embedding: (r as any).embedding ?? null,
        embeddingText: (r as any).embedding_text || "",
      });
    }
    const existingIds = new Set(existingMap.keys());
    const toExtract = allPosts
      .filter((post) => !existingMap.has(post.id) || !parsePgVector(existingMap.get(post.id)?.embedding))
      .slice(0, 60);

    let postsProcessed = 0;
    let featureRowsCreated = 0;
    let semanticEmbeddingsCreated = 0;
    let semanticEmbeddingAttempts = 0;
    let semanticEmbeddingFailures = 0;
    const postEmbeddings = new Map<string, number[]>();
    // Cache for freshly extracted features so we can build the user-profile phase without re-querying
    const freshFeatures = new Map<string, { topics: string[]; hashtags: string[] }>();

    // Batch AI extraction (5 posts in parallel) — keeps cost bounded but ~5x faster than serial
    const EXTRACT_CONCURRENCY = 5;
    for (let i = 0; i < toExtract.length; i += EXTRACT_CONCURRENCY) {
      const chunk = toExtract.slice(i, i + EXTRACT_CONCURRENCY);
      const embeddingTexts = chunk.map((post) => {
        const cached = existingMap.get(post.id);
        return [
          post.body || (post.image_url ? "media image" : "post"),
          (cached?.topics || []).join(" "),
          (cached?.hashtags || []).map((hashtag) => "#" + hashtag).join(" "),
        ].filter(Boolean).join("\n").slice(0, 2000);
      });
      const [features, embeddings] = await Promise.all([
        Promise.all(chunk.map(async (post) => {
          const current = existingMap.get(post.id);
          const hasExtractedMetadata = !!current && (
            current.topics.length > 0
            || current.hashtags.length > 0
            || current.language !== "und"
          );
          const f = hasExtractedMetadata
            ? {
                topics: current.topics,
                hashtags: current.hashtags,
                sentiment: current.sentiment,
                quality: current.quality,
                language: current.language,
              }
            : await extractFeatures(post);
          return f;
        })),
        generateEmbeddingBatch(embeddingTexts),
      ]);
      const results = chunk.map((post, index) => ({
        post,
        f: features[index],
        emb: embeddings[index],
        embText: embeddingTexts[index],
      }));

      semanticEmbeddingAttempts += embeddingTexts.filter((text) => text.trim().length >= 5).length;
      semanticEmbeddingFailures += embeddings.filter((embedding, index) => (
        embeddingTexts[index].trim().length >= 5 && !embedding
      )).length;

      for (const { post, f, emb, embText } of results) {
        const current = existingMap.get(post.id);
        const hadFeatureRow = current !== undefined;
        if (emb) postEmbeddings.set(post.id, emb);
        freshFeatures.set(post.id, { topics: f.topics, hashtags: f.hashtags });
        const featureResult = await supabase.from("ml_post_features").upsert({
          post_id: post.id,
          topics: f.topics,
          hashtags: f.hashtags,
          sentiment: f.sentiment,
          quality_score: f.quality,
          language: f.language,
          has_media: !!post.image_url,
          creator_id: post.user_id,
          embedding_text: embText,
          updated_at: new Date().toISOString(),
          ...(emb ? {
            embedding: toPgVector(emb),
            embedding_source: `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSION}`,
            embedding_updated_at: new Date().toISOString(),
          } : {}),
        });
        if (featureResult.error) throw featureResult.error;
        existingMap.set(post.id, {
          topics: f.topics,
          hashtags: f.hashtags,
          sentiment: f.sentiment,
          quality: f.quality,
          language: f.language,
          embedding: emb || current?.embedding || null,
          embeddingText: embText,
        });
        if (!hadFeatureRow) featureRowsCreated++;
        if (emb) semanticEmbeddingsCreated++;
        postsProcessed++;
      }
    }

    // Also load existing embeddings into the postEmbeddings map (already fetched above — no extra query)
    for (const [pid, row] of existingMap) {
      const embedding = parsePgVector(row.embedding);
      if (embedding?.length === 768) postEmbeddings.set(pid, embedding);
    }

    // Seed only missing 256d rows. ignoreDuplicates makes this race-safe and
    // guarantees that an existing/trained two-tower vector is never replaced.
    let existingItemIds = new Set<string>();
    if (allPosts.length > 0) {
      const itemResult = await supabase
        .from("ml_post_embeddings")
        .select("post_id")
        .in("post_id", allPosts.map((post) => post.id));
      if (itemResult.error) throw itemResult.error;
      existingItemIds = new Set((itemResult.data || []).map((row: any) => row.post_id));
    }
    const seededAt = new Date().toISOString();
    const semanticSeedRows = Array.from(postEmbeddings.entries())
      .filter(([postId]) => !existingItemIds.has(postId))
      .map(([postId, semantic]) => {
        const folded = foldSemanticEmbedding(semantic);
        return folded ? {
          post_id: postId,
          embedding: toPgVector(folded),
          training_samples: 0,
          embedding_source: "semantic_seed",
          semantic_seeded_at: seededAt,
          last_trained_at: seededAt,
          updated_at: seededAt,
        } : null;
      })
      .filter(Boolean);
    if (semanticSeedRows.length > 0) {
      const seedResult = await supabase
        .from("ml_post_embeddings")
        .upsert(semanticSeedRows, {
          onConflict: "post_id",
          ignoreDuplicates: true,
        });
      if (seedResult.error) throw seedResult.error;
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

    // Refresh creator statistics and their aggregate item embedding. This is
    // bounded by the active creator set and uses the service-only RPC.
    const creatorIds = [...new Set(allPosts.map((post) => post.user_id).filter(Boolean))];
    let creatorsRefreshed = 0;
    for (let index = 0; index < creatorIds.length; index += 10) {
      const creatorChunk = creatorIds.slice(index, index + 10);
      const refreshes = await Promise.all(creatorChunk.map((creatorId) => (
        supabase.rpc("ml_refresh_creator_features_v8", { p_creator_id: creatorId })
      )));
      creatorsRefreshed += refreshes.filter((result) => !result.error && result.data === true).length;
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

    // 6) Limited semantic-MMR experiment in shadow mode. It compares the
    // current v8 order with MMR for at most five active users and persists only
    // aggregate diagnostics. No response shown to users is reordered.
    const shadowMetrics: MmrEvaluation[] = [];
    let shadowCandidates = 0;
    let mmrShadowRunId: number | null = null;
    const sampleUserIds = [...new Set(allInter.map((interaction) => interaction.user_id))].slice(0, 5);

    try {
      for (const userId of sampleUserIds) {
        const feedResult = await supabase.rpc("get_feed_posts_v8", {
          p_user_id: userId,
          p_limit: 40,
          p_offset: 0,
        });
        const feedRows = Array.isArray(feedResult.data) ? feedResult.data.slice(0, 40) : [];
        if (feedResult.error || feedRows.length < 2) continue;

        const postIds = feedRows.map((row: any) => row.id).filter(Boolean);
        const semanticResult = await supabase
          .from("ml_post_features")
          .select("post_id, embedding")
          .in("post_id", postIds);
        if (semanticResult.error) continue;
        const semanticByPost = new Map(
          (semanticResult.data || []).map((row: any) => [row.post_id, parsePgVector(row.embedding)]),
        );
        const candidates: SemanticCandidate[] = feedRows.map((row: any) => ({
          id: row.id,
          authorId: row.user_id,
          relevance: Number(row.final_score) || 0,
          embedding: semanticByPost.get(row.id) || null,
        }));
        const reranked = semanticMmrRerank(candidates, 20, 0.82);
        shadowMetrics.push(evaluateMmrShadow(candidates, reranked, 20));
        shadowCandidates += candidates.length;
      }

      const baselineSimilarity = shadowMetrics
        .map((metric) => metric.baselinePairwiseSimilarity)
        .filter((value): value is number => value !== null);
      const mmrSimilarity = shadowMetrics
        .map((metric) => metric.mmrPairwiseSimilarity)
        .filter((value): value is number => value !== null);
      const shadowInsert = await supabase
        .from("ml_feed_mmr_shadow_runs")
        .insert({
          model_run_id: runId || null,
          completed_at: new Date().toISOString(),
          status: shadowMetrics.length > 0 ? "completed" : "skipped",
          sampled_users: shadowMetrics.length,
          candidates_evaluated: shadowCandidates,
          top_k: 20,
          lambda: 0.82,
          semantic_coverage_pct: averageMetric(shadowMetrics.map((metric) => metric.semanticCoveragePct)) || 0,
          top_k_overlap_pct: averageMetric(shadowMetrics.map((metric) => metric.topKOverlapPct)),
          baseline_distinct_author_ratio: averageMetric(shadowMetrics.map((metric) => metric.baselineDistinctAuthorRatio)),
          mmr_distinct_author_ratio: averageMetric(shadowMetrics.map((metric) => metric.mmrDistinctAuthorRatio)),
          baseline_pairwise_similarity: averageMetric(baselineSimilarity),
          mmr_pairwise_similarity: averageMetric(mmrSimilarity),
          mean_relevance_delta: averageMetric(shadowMetrics.map((metric) => metric.meanRelevanceDelta)),
          metadata: {
            mode: "shadow_only",
            baseline: "get_feed_posts_v8",
            challenger: "semantic_mmr",
            production_order_changed: false,
          },
        })
        .select("id")
        .maybeSingle();
      if (!shadowInsert.error && shadowInsert.data?.id) {
        mmrShadowRunId = Number(shadowInsert.data.id);
      } else if (shadowInsert.error) {
        console.error("MMR shadow metrics insert failed:", shadowInsert.error);
      }
    } catch (shadowError) {
      console.error("MMR shadow experiment failed:", shadowError);
    }

    // Persist a coverage snapshot after feature, item and creator refreshes.
    let coverageSnapshotId: number | string | null = null;
    const coverageResult = await supabase.rpc("ml_capture_feed_coverage_snapshot");
    if (!coverageResult.error && coverageResult.data != null) {
      coverageSnapshotId = coverageResult.data as number | string;
    } else if (coverageResult.error) {
      console.error("Coverage snapshot failed:", coverageResult.error);
    }

    // 7) Compute global metrics
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
          total_posts_with_features: featureRowsCreated + existingIds.size,
          avg_dwell_ms: 0,
          users_with_embedding: usersWithEmbedding,
          posts_with_new_embedding: semanticEmbeddingsCreated,
          semantic_embedding_attempts: semanticEmbeddingAttempts,
          semantic_embedding_failures: semanticEmbeddingFailures,
          semantic_seed_rows_created: semanticSeedRows.length,
          creators_refreshed: creatorsRefreshed,
          coverage_snapshot_id: coverageSnapshotId,
          mmr_shadow_run_id: mmrShadowRunId,
          mmr_shadow_sampled_users: shadowMetrics.length,
          mmr_shadow_production_order_changed: false,
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
        semantic_embedding_attempts: semanticEmbeddingAttempts,
        semantic_embedding_failures: semanticEmbeddingFailures,
        semantic_seed_rows_created: semanticSeedRows.length,
        creators_refreshed: creatorsRefreshed,
        coverage_snapshot_id: coverageSnapshotId,
        mmr_shadow_run_id: mmrShadowRunId,
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
