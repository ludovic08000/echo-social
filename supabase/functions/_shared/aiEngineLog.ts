// Shared AI Engine event logger — used by both `zeus` and `ai-engine` edge fns.
// Inserts into public.ai_engine_events (Realtime publication enabled).
// Never throws — fire-and-forget for AI pipelines.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type SupaClient = ReturnType<typeof createClient>;

export interface AIEventInput {
  module_id: string;
  source: "zeus" | "ai-engine";
  action?: string;
  user_id?: string | null;
  latency_ms: number;
  success: boolean;
}

export async function logAIEvent(supabase: SupaClient, evt: AIEventInput) {
  try {
    await supabase.from("ai_engine_events" as any).insert({
      module_id: evt.module_id,
      source: evt.source,
      action: evt.action ?? null,
      user_id: evt.user_id ?? null,
      latency_ms: Math.max(0, Math.round(evt.latency_ms)),
      success: evt.success,
    });
  } catch (_) {
    // intentional: logging must not break AI flows
  }
}

// Map a Zeus (domain, action) tuple to one of the registered aiEngine module ids.
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
