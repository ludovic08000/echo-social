/**
 * AI Threat Shield — pipeline actif :
 *   1. Pré-filtre regex (label "attack" si match haute confiance)
 *   2. Modèle ML local (logistic régression online) → si très confiant, action directe
 *   3. Zone d'incertitude → Gemini 2.5 Flash décide ET label le sample
 *   4. Action automatique + log threat_decisions + sample threat_training_samples
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractFeatures, predict, FEATURE_DIM } from "../_shared/threat-features.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

// ── Signatures regex haute confiance ─────────────────────────────────────────
const SIGNATURES: { rx: RegExp; cat: string; conf: number }[] = [
  { rx: /\b(union\s+select|select\s.+\sfrom\s|insert\s+into\s|drop\s+table|truncate\s+table)\b/i, cat: "sql_injection", conf: 95 },
  { rx: /\bor\s+1\s*=\s*1\b|\band\s+1\s*=\s*1\b/i, cat: "sql_injection", conf: 92 },
  { rx: /(pg_sleep|sleep\s*\(\s*\d+\s*\)|benchmark\s*\()/i, cat: "sql_injection", conf: 95 },
  { rx: /\binformation_schema\b|\bpg_catalog\b/i, cat: "sql_injection", conf: 88 },
  { rx: /<script[\s>]|<\/script>/i, cat: "xss", conf: 95 },
  { rx: /\b(onerror|onload|onclick|onmouseover|onfocus|onpointerdown)\s*=/i, cat: "xss", conf: 90 },
  { rx: /javascript:\s*[a-z0-9_(]/i, cat: "xss", conf: 92 },
  { rx: /<iframe[\s>]|<svg[^>]*onload|<img[^>]*onerror/i, cat: "xss", conf: 95 },
  { rx: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i, cat: "prompt_injection", conf: 92 },
  { rx: /(reveal|show|print|leak)\s+(your\s+)?(system\s+)?prompt/i, cat: "prompt_injection", conf: 92 },
  { rx: /you\s+are\s+now\s+(dan|developer\s+mode|jailbroken)/i, cat: "prompt_injection", conf: 95 },
  { rx: /\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\//i, cat: "path_traversal", conf: 90 },
  { rx: /(file|gopher|dict|ftp):\/\//i, cat: "ssrf", conf: 88 },
  { rx: /\$where\s*:|\$ne\s*:|\$gt\s*:|\$regex\s*:/i, cat: "nosql_injection", conf: 85 },
  { rx: /\{\{\s*\d+\s*\*\s*\d+\s*\}\}/i, cat: "template_injection", conf: 90 },
  { rx: /(\||;|`|\$\()\s*(cat|ls|whoami|id|uname|curl|wget|nc|bash|sh)\b/i, cat: "command_injection", conf: 92 },
];

function regexScan(text: string): { cat: string; conf: number; rule: string } | null {
  let best: { cat: string; conf: number; rule: string } | null = null;
  for (const sig of SIGNATURES) {
    if (sig.rx.test(text)) {
      if (!best || sig.conf > best.conf) best = { cat: sig.cat, conf: sig.conf, rule: sig.rx.source.slice(0, 40) };
    }
  }
  return best;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Cache modèle (60s)
let modelCache: { weights: number[]; bias: number; version: number; samples: number; at: number } | null = null;
async function getModel(supabase: any) {
  if (modelCache && Date.now() - modelCache.at < 60_000) return modelCache;
  const { data } = await supabase.rpc("threat_shield_active_model");
  if (Array.isArray(data) && data[0]?.weights) {
    const row = data[0];
    modelCache = {
      weights: row.weights as number[],
      bias: row.bias ?? 0,
      version: row.version,
      samples: row.samples_used,
      at: Date.now(),
    };
    return modelCache;
  }
  modelCache = { weights: [], bias: 0, version: 0, samples: 0, at: Date.now() };
  return modelCache;
}

async function aiScore(payload: string, endpoint: string, ua: string) {
  if (!LOVABLE_API_KEY) return null;
  const sys = `Analyste sécurité L7. Classe ce payload HTTP suspect parmi: sql_injection, xss, prompt_injection, ssrf, path_traversal, nosql_injection, template_injection, command_injection, scraping, credential_stuffing, spam, benign.
Renvoie UNIQUEMENT un JSON: {"category":"...","confidence":0-100,"reason":"≤120 chars FR"}.
Conservateur: confidence ≥ 85 seulement si attaque évidente.`;
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LOVABLE_API_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `Endpoint: ${endpoint}\nUA: ${ua.slice(0, 200)}\nPayload:\n${payload.slice(0, 3500)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (typeof parsed?.category !== "string" || typeof parsed?.confidence !== "number") return null;
    return {
      category: parsed.category as string,
      confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
      reason: String(parsed.reason ?? "").slice(0, 200),
    };
  } catch { return null; }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Require an authenticated caller so anonymous attackers can't poison the
  // training set or trigger auto-bans of arbitrary IPs.
  const { requireAuthenticated } = await import("../_shared/auth-guard.ts");
  const authed = await requireAuthenticated(req, corsHeaders);
  if (!("userId" in authed)) return authed.response;

  try {
    const body = await req.json().catch(() => ({}));
    const { endpoint = "unknown", payload = "", headers: hdrs = {}, mode = "inspect" } = body ?? {};
    // user_id is always derived from the verified JWT — never trust client input.
    const user_id = authed.userId;

    const ip = req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") || "unknown";
    const ua = (hdrs["user-agent"] || req.headers.get("user-agent") || "").toString();

    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    const sample = text.slice(0, 4096);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // [1] Regex
    const reg = regexScan(`${sample}\n${ua}`);

    // [2] ML
    const model = await getModel(supabase);
    const features = extractFeatures({
      payload: sample, endpoint, ua,
      hourUtc: new Date().getUTCHours(),
      regexConf: reg?.conf ?? 0,
    });
    const mlReady = model.weights.length === FEATURE_DIM && model.samples >= 200;
    const mlProb = mlReady ? predict(features, model.weights, model.bias) : null;

    // [3] Décision
    let category = "benign", confidence = 0, reason = "", decidedBy: "regex"|"ml"|"gemini"|"hybrid" = "ml";
    let detector: "regex"|"ai"|"hybrid"|"client" = "regex";
    let label: 0|1 = 0;
    let needGemini = false;

    if (reg && reg.conf >= 85) {
      category = reg.cat; confidence = reg.conf; reason = `Signature: ${reg.rule}`;
      decidedBy = "regex"; detector = "regex"; label = 1;
    } else if (mlProb !== null && (mlProb >= 0.85 || mlProb < 0.15)) {
      category = mlProb >= 0.5 ? (reg?.cat ?? "ml_attack") : "benign";
      confidence = Math.round(mlProb * 100);
      reason = `ML v${model.version} prob=${mlProb.toFixed(2)}`;
      decidedBy = "ml"; detector = "ai"; label = mlProb >= 0.5 ? 1 : 0;
    } else {
      needGemini = true;
    }

    if (needGemini) {
      const ai = await aiScore(sample, endpoint, ua);
      if (ai) {
        category = ai.category;
        confidence = ai.confidence;
        reason = ai.reason;
        decidedBy = mlProb !== null ? "hybrid" : "gemini";
        detector = "ai";
        label = (ai.category !== "benign" && ai.confidence >= 60) ? 1 : 0;
      } else {
        // fallback : on prend le ML s'il existe, sinon benign
        if (mlProb !== null) {
          category = mlProb >= 0.5 ? "ml_attack" : "benign";
          confidence = Math.round(mlProb * 100);
          reason = `ML fallback prob=${mlProb.toFixed(2)}`;
          decidedBy = "ml"; label = mlProb >= 0.5 ? 1 : 0;
        }
      }
    }

    // Action
    let action: "allow"|"log"|"penalize"|"ban" = "allow";
    if (confidence >= 85 && category !== "benign") action = "ban";
    else if (confidence >= 60 && category !== "benign") action = "penalize";
    else if (confidence >= 30 && category !== "benign") action = "log";

    const payloadHash = sample ? await sha256(sample) : null;

    // Log decision
    if (action !== "allow" || mode === "test") {
      await supabase.from("threat_decisions").insert({
        endpoint: String(endpoint).slice(0, 200),
        ip, user_id,
        category, confidence,
        reason: reason.slice(0, 500),
        action_taken: action,
        detector,
        decided_by: decidedBy,
        payload_hash: payloadHash,
        user_agent: ua.slice(0, 300),
      });
    }

    // Active learning : on stocke un sample si Gemini ou regex haute confiance
    // (jamais sur ML pour ne pas se renforcer en boucle fermée)
    if (decidedBy === "regex" || decidedBy === "gemini" || decidedBy === "hybrid") {
      await supabase.from("threat_training_samples").insert({
        features: features,
        label,
        source: decidedBy === "regex" ? "regex" : "gemini",
        weight: 1.0,
        category,
        endpoint: String(endpoint).slice(0, 200),
      }).then(() => {}, () => {});
    }

    // Enforcement
    if (action === "ban" && ip !== "unknown" && mode !== "test") {
      await supabase.from("banned_ips").insert({
        ip, reason: `AI Shield (${decidedBy}): ${category} (${confidence})`,
        banned_until: new Date(Date.now() + 24 * 3600_000).toISOString(),
        severity: "critical",
      }).then(() => {}, () => {});
      await supabase.from("security_incidents").insert({
        type: category, severity: "critical", source_ip: ip,
        details: { reason, endpoint, decided_by: decidedBy, confidence, ua: ua.slice(0, 200) },
      }).then(() => {}, () => {});
    }

    supabase.from("ai_engine_events").insert({
      module: "ai_threat_shield",
      action, success: action !== "ban",
      latency_ms: 0,
      payload: { category, confidence, decided_by: decidedBy, endpoint, model_version: model.version },
    }).then(() => {}, () => {});

    return new Response(
      JSON.stringify({ action, category, confidence, decided_by: decidedBy, detector, reason, model_version: model.version, ml_prob: mlProb }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ action: "allow", error: String(e) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
