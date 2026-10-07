// Offline, reproducible challenger. Training never replaces the live vectors.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.0";
import { getCorsHeaders } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/auth-guard.ts";
import { trainFeedCandidate, type TrainingEvent } from "../_shared/feed-two-tower.ts";

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const guard = await requireAdmin(req, headers);
  if (!("userId" in guard)) return guard.response;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { global: {
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) }),
  } });
  const owner = crypto.randomUUID(), started = Date.now();
  const lease = await db.rpc("claim_feed_training_lease", { p_name: "two_tower", p_owner: owner });
  if (lease.error) return new Response(JSON.stringify({ error: "TRAINING_LEASE_UNAVAILABLE" }), { status: 503, headers });
  if (!lease.data) return new Response(JSON.stringify({ skipped: "RUN_ALREADY_ACTIVE" }), { status: 202, headers });
  try {
    const events: TrainingEvent[] = [];
    for (let offset=0; offset<5000; offset+=1000) {
      const batch = await db.rpc("feed_training_events", { p_limit: 5000, p_as_of: new Date(started).toISOString() }).range(offset, offset+999);
      if (batch.error) throw batch.error;
      events.push(...(batch.data || []));
      if ((batch.data || []).length<1000) break;
    }
    const candidate = trainFeedCandidate(events);
    const status = candidate.metrics.offline_gate ? "candidate" : "rejected";
    // One atomic insert, no interrupted sequence of user/item writes.
    const saved = await db.from("feed_model_candidates").insert({
      kind: "two_tower", status, metrics: candidate.metrics,
      artifacts: status === "candidate" ? candidate.artifacts : {},
    }).select("id").single();
    if (saved.error) throw saved.error;
    return new Response(JSON.stringify({
      candidate_id: saved.data.id, status, ...candidate.metrics,
      trained_samples: events.length, users_updated: 0, posts_updated: 0,
      elapsed_ms: Date.now()-started,
      message: "Candidat évalué hors ligne ; modèle actif inchangé. Validation en ligne requise avant promotion.",
    }), { headers });
  } catch (error) {
    console.error("[feed-candidate]", error instanceof Error ? error.name : "failure");
    return new Response(JSON.stringify({ error: "CANDIDATE_TRAINING_FAILED" }), { status: 500, headers });
  } finally {
    await db.from("feed_training_leases").delete().eq("name","two_tower").eq("owner",owner);
  }
});
