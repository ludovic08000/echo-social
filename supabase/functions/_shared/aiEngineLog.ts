// Shared AI Engine event logger — used by both `zeus` and `ai-engine` edge fns.
// Inserts into public.ai_engine_events. Logging is best-effort and never breaks
// the caller's AI pipeline.

type AIEventClient = {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<unknown>;
  };
};

export interface AIEventInput {
  module_id: string;
  source: "zeus" | "ai-engine";
  action?: string;
  user_id?: string | null;
  latency_ms: number;
  success: boolean;
}

export async function logAIEvent(supabase: AIEventClient, evt: AIEventInput) {
  try {
    await supabase.from("ai_engine_events").insert({
      module_id: evt.module_id,
      source: evt.source,
      action: evt.action ?? null,
      user_id: evt.user_id ?? null,
      latency_ms: Math.max(0, Math.round(evt.latency_ms)),
      success: evt.success,
    });
  } catch {
    // Intentional: telemetry must not break AI flows.
  }
}

export function zeusModuleId(domain: string, action?: string): string {
  switch (domain) {
    case "content":
      if (action === "summarize") return "content-summarizer";
      if (action === "translate") return "auto-translator";
      if (action === "correct" || action === "enhance") return "content-enhancer";
      return "content-enhancer";
    case "post": return "content-enhancer";
    case "moderation": return "ai-moderator";
    case "post-moderation": return "ai-moderator";
    case "comment-moderation": return "ai-moderator";
    case "ads": return "content-enhancer";
    case "seller": return "recommendation-engine";
    case "photo": return "ai-moderator";
    case "agent": return "smart-reply";
    case "admin": return "recommendation-engine";
    default: return `zeus-${domain}`;
  }
}
