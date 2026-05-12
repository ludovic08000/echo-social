import { supabase } from "@/integrations/supabase/client";

export type ThreatAction = "allow" | "log" | "penalize" | "ban";
export type ThreatResult = {
  action: ThreatAction;
  category: string;
  confidence: number;
  detector?: string;
  reason?: string;
  blocked: boolean;
};

// Pré-filtre client ultra-léger : bloque les payloads évidents avant
// de consommer un appel serveur. La décision finale reste serveur.
const CLIENT_RX = [
  /<script[\s>]/i,
  /\b(union\s+select|drop\s+table|or\s+1\s*=\s*1)\b/i,
  /javascript:\s*[a-z(]/i,
  /\bonerror\s*=/i,
  /ignore\s+(all\s+)?previous\s+(instructions|prompts)/i,
  /(reveal|leak|print)\s+(your\s+)?system\s+prompt/i,
  /\.\.\/\.\.\//,
];

function clientPrefilter(payload: string): boolean {
  if (!payload || payload.length < 4) return false;
  return CLIENT_RX.some((rx) => rx.test(payload));
}

// Cache local 60s pour éviter de re-scorer le même endpoint+payload
const cache = new Map<string, { at: number; res: ThreatResult }>();
const TTL_MS = 60_000;

export async function inspectThreat(opts: {
  endpoint: string;
  payload: string | Record<string, unknown>;
  user_id?: string | null;
  mode?: "inspect" | "test";
}): Promise<ThreatResult> {
  const text = typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload ?? "");
  const key = `${opts.endpoint}|${text.slice(0, 200)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.res;

  // Pré-filtre client
  if (clientPrefilter(text)) {
    const res: ThreatResult = {
      action: "ban", category: "client_prefilter", confidence: 95,
      detector: "client", reason: "Bloqué côté client", blocked: true,
    };
    // On informe quand même le serveur pour traçabilité + ban IP
    void supabase.functions.invoke("ai-threat-shield", {
      body: {
        endpoint: opts.endpoint,
        payload: text.slice(0, 4000),
        user_id: opts.user_id ?? null,
        headers: { "user-agent": navigator.userAgent },
        mode: opts.mode ?? "inspect",
      },
    }).catch(() => {});
    cache.set(key, { at: Date.now(), res });
    return res;
  }

  try {
    const { data, error } = await supabase.functions.invoke("ai-threat-shield", {
      body: {
        endpoint: opts.endpoint,
        payload: text.slice(0, 4000),
        user_id: opts.user_id ?? null,
        headers: { "user-agent": navigator.userAgent },
        mode: opts.mode ?? "inspect",
      },
    });
    if (error || !data) {
      const res: ThreatResult = { action: "allow", category: "benign", confidence: 0, blocked: false };
      return res;
    }
    const res: ThreatResult = {
      action: data.action,
      category: data.category,
      confidence: data.confidence,
      detector: data.detector,
      reason: data.reason,
      blocked: data.action === "ban",
    };
    cache.set(key, { at: Date.now(), res });
    return res;
  } catch {
    return { action: "allow", category: "benign", confidence: 0, blocked: false };
  }
}

export function useThreatShield() {
  return { inspect: inspectThreat };
}
