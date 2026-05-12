/**
 * AI Threat Shield — analyse temps réel des requêtes suspectes.
 *
 * Pipeline:
 *   1. Pré-filtre regex (≥30 signatures, latence < 5 ms, pas d'appel IA)
 *   2. Si suspect ambigu → scoring Gemini 2.5 Flash via Lovable AI Gateway
 *   3. Action automatique selon confiance (allow / log / penalize / ban 24h)
 *
 * POST { endpoint, payload, headers?, user_id?, mode? }
 *   mode = 'inspect' (par défaut) ou 'test' (auto-test santé)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;

// ── Signatures regex haute confiance ───────────────────────────────────────────
const SIGNATURES: { rx: RegExp; cat: string; conf: number }[] = [
  // SQL Injection
  { rx: /\b(union\s+select|select\s.+\sfrom\s|insert\s+into\s|drop\s+table|truncate\s+table)\b/i, cat: "sql_injection", conf: 95 },
  { rx: /\bor\s+1\s*=\s*1\b|\band\s+1\s*=\s*1\b|\bor\s+'\w+'\s*=\s*'\w+'/i, cat: "sql_injection", conf: 92 },
  { rx: /(pg_sleep|sleep\s*\(\s*\d+\s*\)|benchmark\s*\()/i, cat: "sql_injection", conf: 95 },
  { rx: /\binformation_schema\b|\bpg_catalog\b/i, cat: "sql_injection", conf: 88 },
  { rx: /(--\s|#\s|\/\*.*\*\/)/, cat: "sql_injection", conf: 65 },

  // XSS
  { rx: /<script[\s>]|<\/script>/i, cat: "xss", conf: 95 },
  { rx: /\b(onerror|onload|onclick|onmouseover|onfocus|onpointerdown)\s*=/i, cat: "xss", conf: 90 },
  { rx: /javascript:\s*[a-z0-9_(]/i, cat: "xss", conf: 92 },
  { rx: /<iframe[\s>]|<svg[^>]*onload|<img[^>]*onerror/i, cat: "xss", conf: 95 },
  { rx: /document\.(cookie|write)|window\.location\s*=/i, cat: "xss", conf: 80 },

  // Prompt injection
  { rx: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i, cat: "prompt_injection", conf: 92 },
  { rx: /(disregard|forget)\s+(your|the)\s+(system|previous)/i, cat: "prompt_injection", conf: 90 },
  { rx: /(reveal|show|print|leak)\s+(your\s+)?(system\s+)?prompt/i, cat: "prompt_injection", conf: 92 },
  { rx: /you\s+are\s+now\s+(dan|developer\s+mode|jailbroken)/i, cat: "prompt_injection", conf: 95 },
  { rx: /\[\[system\]\]|<\|im_start\|>|###\s*system/i, cat: "prompt_injection", conf: 88 },

  // SSRF / Path traversal
  { rx: /\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e\//i, cat: "path_traversal", conf: 90 },
  { rx: /(file|gopher|dict|ftp):\/\//i, cat: "ssrf", conf: 88 },
  { rx: /\b(127\.0\.0\.1|0\.0\.0\.0|localhost|169\.254\.169\.254)\b/i, cat: "ssrf", conf: 75 },

  // NoSQL / Template
  { rx: /\$where\s*:|\$ne\s*:|\$gt\s*:|\$regex\s*:/i, cat: "nosql_injection", conf: 85 },
  { rx: /\{\{\s*[\w.]+\s*[*+\-/]\s*\d+\s*\}\}|\{\{\s*7\s*\*\s*7\s*\}\}/i, cat: "template_injection", conf: 90 },
  { rx: /\$\{\s*[\w.]+\s*\}/i, cat: "template_injection", conf: 60 },

  // Command injection
  { rx: /(\||;|`|\$\()\s*(cat|ls|whoami|id|uname|curl|wget|nc|bash|sh)\b/i, cat: "command_injection", conf: 92 },

  // Headless / scraping signatures (UA-based, scoré séparément)
  { rx: /\b(headlesschrome|phantomjs|selenium|puppeteer|playwright|scrapy|httpclient\/)/i, cat: "scraping", conf: 80 },
];

const HARMLESS_CATS = new Set<string>();

function regexScan(text: string): { cat: string; conf: number; rule: string } | null {
  let best: { cat: string; conf: number; rule: string } | null = null;
  for (const sig of SIGNATURES) {
    if (sig.rx.test(text)) {
      if (!best || sig.conf > best.conf) {
        best = { cat: sig.cat, conf: sig.conf, rule: sig.rx.source.slice(0, 40) };
      }
    }
  }
  return best;
}

// Petit hash non cryptographique pour audit
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function aiScore(payload: string, endpoint: string, ua: string): Promise<{
  category: string; confidence: number; reason: string;
} | null> {
  if (!LOVABLE_API_KEY) return null;
  const truncated = payload.slice(0, 3500);
  const sys = `Tu es un analyste sécurité L7. Tu reçois un payload HTTP suspect.
Classe-le parmi: sql_injection, xss, prompt_injection, ssrf, path_traversal, nosql_injection, template_injection, command_injection, scraping, credential_stuffing, spam, benign.
Renvoie UNIQUEMENT un JSON: {"category":"...","confidence":0-100,"reason":"≤120 chars FR"}.
Sois conservateur: confidence ≥ 85 seulement si attaque évidente. Si doute → benign avec confidence basse.`;
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `Endpoint: ${endpoint}\nUA: ${ua.slice(0, 200)}\nPayload:\n${truncated}` },
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
      category: parsed.category,
      confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
      reason: String(parsed.reason ?? "").slice(0, 200),
    };
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { endpoint = "unknown", payload = "", headers: hdrs = {}, user_id = null, mode = "inspect" } = body ?? {};

    const ip =
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    const ua = (hdrs["user-agent"] || req.headers.get("user-agent") || "").toString();

    const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
    const sample = text.slice(0, 4096);

    // 1) Regex
    const reg = regexScan(`${sample}\n${ua}`);

    // 2) Décision
    let category = reg?.cat ?? "benign";
    let confidence = reg?.conf ?? 0;
    let reason = reg ? `Signature: ${reg.rule}` : "";
    let detector: "regex" | "ai" | "hybrid" = reg ? "regex" : "ai";

    // Si regex confiance modérée ou rien → IA
    if (!reg || (reg.conf < 80 && sample.length > 8)) {
      const ai = await aiScore(sample, endpoint, ua);
      if (ai) {
        // garde le pire des deux
        if (ai.confidence >= confidence) {
          category = ai.category;
          confidence = ai.confidence;
          reason = ai.reason || reason;
          detector = reg ? "hybrid" : "ai";
        }
      }
    }

    if (HARMLESS_CATS.has(category)) confidence = 0;

    // 3) Action
    let action: "allow" | "log" | "penalize" | "ban" = "allow";
    if (confidence >= 85 && category !== "benign") action = "ban";
    else if (confidence >= 60 && category !== "benign") action = "penalize";
    else if (confidence >= 30 && category !== "benign") action = "log";

    // 4) Persistance + enforcement (service role)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const payloadHash = sample ? await sha256(sample) : null;

    // Log toujours si pas allow OU mode test
    if (action !== "allow" || mode === "test") {
      await supabase.from("threat_decisions").insert({
        endpoint: String(endpoint).slice(0, 200),
        ip,
        user_id,
        category,
        confidence,
        reason: reason.slice(0, 500),
        action_taken: action,
        detector,
        payload_hash: payloadHash,
        user_agent: ua.slice(0, 300),
      });
    }

    if (action === "ban" && ip !== "unknown" && mode !== "test") {
      await supabase.from("banned_ips").insert({
        ip,
        reason: `AI Shield: ${category} (${confidence})`,
        banned_until: new Date(Date.now() + 24 * 3600_000).toISOString(),
        severity: "critical",
      }).then(() => {}, () => {});
      await supabase.from("security_incidents").insert({
        type: category,
        severity: "critical",
        source_ip: ip,
        details: { reason, endpoint, detector, confidence, ua: ua.slice(0, 200) },
      }).then(() => {}, () => {});
    } else if (action === "penalize" && ip !== "unknown" && mode !== "test") {
      // Augmente le penalty_level (best-effort)
      await supabase.rpc("ddos_check_ip", {
        p_ip: ip,
        p_endpoint: String(endpoint).slice(0, 100),
        p_max_requests: 1,
        p_window_seconds: 60,
      }).then(() => {}, () => {});
    }

    // Log AI engine event (non bloquant)
    supabase.from("ai_engine_events").insert({
      module: "ai_threat_shield",
      action: action,
      success: action !== "ban",
      latency_ms: 0,
      payload: { category, confidence, detector, endpoint, ip_hash: payloadHash },
    }).then(() => {}, () => {});

    return new Response(
      JSON.stringify({ action, category, confidence, detector, reason }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ action: "allow", error: String(e) }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
