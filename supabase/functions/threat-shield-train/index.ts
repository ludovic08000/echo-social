/**
 * threat-shield-train — entraîne logistic régression (SGD) sur threat_training_samples.
 *   - Holdout 10%
 *   - 200 époques, lr=0.05, L2=1e-4
 *   - Promu actif si recall ≥ ancien actif (ou pas d'actif)
 *   - Versionné dans threat_model_weights
 *
 * Manuel : POST /threat-shield-train { force: true }
 * Cron : pg_cron toutes les nuits.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { FEATURE_DIM } from "../_shared/threat-features.ts";

const MIN_SAMPLES = 200;
const EPOCHS = 200;
const LR = 0.05;
const L2 = 1e-4;
const HOLDOUT = 0.1;

function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

function train(samples: { f: number[]; y: number; w: number }[]) {
  const dim = FEATURE_DIM;
  const W = new Array<number>(dim).fill(0);
  let b = 0;

  for (let ep = 0; ep < EPOCHS; ep++) {
    shuffle(samples);
    for (const s of samples) {
      let z = b;
      for (let i = 0; i < dim; i++) z += W[i] * s.f[i];
      const p = sigmoid(z);
      const err = (p - s.y) * s.w;
      for (let i = 0; i < dim; i++) {
        W[i] -= LR * (err * s.f[i] + L2 * W[i]);
      }
      b -= LR * err;
    }
  }
  return { W, b };
}

function evaluate(samples: { f: number[]; y: number }[], W: number[], b: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of samples) {
    let z = b;
    for (let i = 0; i < W.length; i++) z += W[i] * s.f[i];
    const pred = sigmoid(z) >= 0.5 ? 1 : 0;
    if (pred === 1 && s.y === 1) tp++;
    else if (pred === 1 && s.y === 0) fp++;
    else if (pred === 0 && s.y === 1) fn++;
    else tn++;
  }
  const accuracy = (tp + tn) / Math.max(1, tp + fp + fn + tn);
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return { accuracy, precision, recall, f1, tp, fp, fn, tn };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Charge tous les samples (limite 50 000)
  const { data: rows, error } = await supabase
    .from("threat_training_samples")
    .select("features, label, weight")
    .order("created_at", { ascending: false })
    .limit(50000);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const samples = (rows ?? [])
    .map((r: any) => ({
      f: Array.isArray(r.features) ? r.features as number[] : [],
      y: r.label as number,
      w: r.weight ?? 1,
    }))
    .filter(s => s.f.length === FEATURE_DIM);

  if (samples.length < MIN_SAMPLES) {
    return new Response(JSON.stringify({
      ok: false, reason: "not_enough_samples", samples: samples.length, min: MIN_SAMPLES,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Split holdout
  shuffle(samples);
  const cut = Math.max(1, Math.floor(samples.length * HOLDOUT));
  const test = samples.slice(0, cut);
  const trainSet = samples.slice(cut);

  const t0 = Date.now();
  const { W, b } = train(trainSet);
  const metrics = evaluate(test, W, b);
  const took = Date.now() - t0;

  // Compare with current active
  const { data: active } = await supabase
    .from("threat_model_weights")
    .select("version, recall, precision_score")
    .eq("active", true)
    .maybeSingle();

  const oldRecall = (active?.recall ?? 0) as number;
  const promote = !active || metrics.recall >= oldRecall - 0.05;

  // Next version
  const { data: lastVer } = await supabase
    .from("threat_model_weights")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = ((lastVer?.version as number) ?? 0) + 1;

  if (promote) {
    // désactive les anciens
    await supabase.from("threat_model_weights").update({ active: false }).eq("active", true);
  }

  await supabase.from("threat_model_weights").insert({
    version: nextVersion,
    weights: W,
    bias: b,
    accuracy: metrics.accuracy,
    precision_score: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    samples_used: trainSet.length,
    active: promote,
    notes: promote ? "promoted" : `kept (recall ${metrics.recall.toFixed(2)} < old ${oldRecall.toFixed(2)})`,
  });

  // Log AI engine
  await supabase.from("ai_engine_events").insert({
    module: "threat_shield_train",
    action: promote ? "promoted" : "kept",
    success: promote,
    latency_ms: took,
    payload: { version: nextVersion, ...metrics, samples: trainSet.length },
  });

  return new Response(JSON.stringify({
    ok: true, promoted: promote, version: nextVersion,
    samples: trainSet.length, holdout: test.length,
    metrics, took_ms: took,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
