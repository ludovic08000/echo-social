// Two-Tower training job — nightly mini-batch SGD on ml_interactions
// Updates user & post embeddings (256d) so dot product approximates engagement.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EMBED_DIM = 256;
const LR = 0.05;
const EPOCHS = 2;
const BATCH_LIMIT = 5000;

function randomEmbedding(): number[] {
  const v = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    v[i] = (Math.random() - 0.5) * 0.1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < EMBED_DIM; i++) s += a[i] * b[i];
  return s;
}

function l2Normalize(v: number[]): number[] {
  let n = 0;
  for (let i = 0; i < EMBED_DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function parsePgVector(s: string | null): number[] | null {
  if (!s) return null;
  try {
    const arr = JSON.parse(s.replace(/^\[/, "[").replace(/\]$/, "]"));
    if (Array.isArray(arr) && arr.length === EMBED_DIM) return arr.map(Number);
  } catch {}
  return null;
}

function toPgVector(v: number[]): string {
  return "[" + v.map((x) => x.toFixed(6)).join(",") + "]";
}

// Convert ML signal type to a positive/negative label in [-1, 1]
const SIGNAL_LABEL: Record<string, number> = {
  view: 0.1,
  dwell_long: 0.7,
  like: 0.8,
  comment: 0.9,
  share: 1.0,
  click: 0.5,
  hide: -0.8,
  report: -1.0,
  skip_fast: -0.4,
};

// Wall-clock budget so we always return cleanly before Supabase's hard timeout
// (defaults to ~150s on Edge Functions). We exit early and persist whatever
// progress was made — better partial training than a 500.
const SOFT_BUDGET_MS = 90_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const { requireAdmin } = await import("../_shared/auth-guard.ts");
  const guard = await requireAdmin(req, corsHeaders);
  if (!("userId" in guard)) return guard.response;

  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt > SOFT_BUDGET_MS;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1) Pull recent interactions
    const { data: interactions, error } = await supabase
      .from("ml_interactions")
      .select("user_id, post_id, signal_type")
      .gte("created_at", new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString())
      .limit(BATCH_LIMIT);

    if (error) throw error;
    if (!interactions || interactions.length === 0) {
      return new Response(
        JSON.stringify({ trained_samples: 0, message: "No recent interactions" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2) Load existing embeddings
    const userIds = [...new Set(interactions.map((i) => i.user_id))];
    const postIds = [...new Set(interactions.map((i) => i.post_id))];

    const [{ data: userEmbs }, { data: postEmbs }] = await Promise.all([
      supabase.from("ml_user_embeddings").select("user_id, embedding").in("user_id", userIds),
      supabase.from("ml_post_embeddings").select("post_id, embedding").in("post_id", postIds),
    ]);

    const userMap = new Map<string, number[]>();
    const postMap = new Map<string, number[]>();
    for (const u of userEmbs || []) {
      const v = parsePgVector(u.embedding as any);
      userMap.set(u.user_id, v || randomEmbedding());
    }
    for (const p of postEmbs || []) {
      const v = parsePgVector(p.embedding as any);
      postMap.set(p.post_id, v || randomEmbedding());
    }
    for (const uid of userIds) if (!userMap.has(uid)) userMap.set(uid, randomEmbedding());
    for (const pid of postIds) if (!postMap.has(pid)) postMap.set(pid, randomEmbedding());

    // 3) Mini-batch SGD: for each (user, post, label), nudge embeddings so dot ≈ label
    let totalLoss = 0;
    let epochsRun = 0;
    for (let epoch = 0; epoch < EPOCHS; epoch++) {
      if (overBudget()) break;
      const order = interactions.map((_, i) => i).sort(() => Math.random() - 0.5);
      for (const idx of order) {
        const it = interactions[idx];
        const label = SIGNAL_LABEL[it.signal_type] ?? 0;
        const u = userMap.get(it.user_id)!;
        const p = postMap.get(it.post_id)!;
        const pred = Math.tanh(dot(u, p));
        const err = pred - label;
        totalLoss += err * err;
        const grad = err * (1 - pred * pred);
        for (let i = 0; i < EMBED_DIM; i++) {
          const gu = grad * p[i];
          const gp = grad * u[i];
          u[i] -= LR * gu;
          p[i] -= LR * gp;
        }
      }
      epochsRun++;
    }

    // Pre-compute training_samples counts in O(N) instead of O(N*M)
    const userSampleCount = new Map<string, number>();
    const postSampleCount = new Map<string, number>();
    for (const it of interactions) {
      userSampleCount.set(it.user_id, (userSampleCount.get(it.user_id) || 0) + 1);
      postSampleCount.set(it.post_id, (postSampleCount.get(it.post_id) || 0) + 1);
    }

    // 4) Normalize and persist
    const nowIso = new Date().toISOString();
    const userRows = [];
    const postRows = [];
    for (const [uid, vec] of userMap) {
      userRows.push({
        user_id: uid,
        embedding: toPgVector(l2Normalize(vec)),
        training_samples: userSampleCount.get(uid) || 0,
        last_trained_at: nowIso,
        updated_at: nowIso,
      });
    }
    for (const [pid, vec] of postMap) {
      postRows.push({
        post_id: pid,
        embedding: toPgVector(l2Normalize(vec)),
        training_samples: postSampleCount.get(pid) || 0,
        last_trained_at: nowIso,
        updated_at: nowIso,
      });
    }

    // Upsert in chunks of 200
    const chunk = <T>(arr: T[], n: number) =>
      Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

    for (const c of chunk(userRows, 200)) {
      if (overBudget()) break;
      await supabase.from("ml_user_embeddings").upsert(c, { onConflict: "user_id" });
    }
    for (const c of chunk(postRows, 200)) {
      if (overBudget()) break;
      await supabase.from("ml_post_embeddings").upsert(c, { onConflict: "post_id" });
    }

    // 5) Refresh multi-head scores for trained posts (capped + budgeted)
    const postsToRefresh = overBudget() ? [] : postIds.slice(0, 500);
    await Promise.all(
      postsToRefresh.map(async (pid) => {
        if (overBudget()) return;
        try {
          await supabase.rpc("ml_compute_post_scores", { p_post_id: pid });
        } catch (_e) {
          // best-effort score refresh — ignore individual failures
        }
      })
    );

    return new Response(
      JSON.stringify({
        trained_samples: interactions.length,
        users_updated: userRows.length,
        posts_updated: postRows.length,
        epochs_run: epochsRun,
        avg_loss: epochsRun > 0 ? totalLoss / (interactions.length * epochsRun) : null,
        scores_refreshed: postsToRefresh.length,
        elapsed_ms: Date.now() - startedAt,
        budget_hit: overBudget(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[ml-twotower-train]", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
