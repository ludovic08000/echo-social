/**
 * AI Privacy Helper — RGPD compliance
 *
 * Used by Edge Functions that send user content/signals to external AI services
 * (Lovable AI Gateway, Gemini, etc.) to enforce the user's opt-out preference
 * (privacy_settings.ai_data_sharing_enabled = false) and to truncate / sanitize
 * payloads before they leave the platform.
 *
 * Behaviour:
 *  - If the user has disabled AI data sharing, personal signals (behavior, history,
 *    profile context) MUST NOT be sent. The caller should fall back to a generic
 *    or anonymized prompt.
 *  - Free-form text snippets (post bodies, comments, messages used for moderation)
 *    are always truncated to MAX_BODY_PREVIEW chars.
 *  - PII patterns (emails, phones, long digit sequences) are stripped.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const MAX_BODY_PREVIEW = 200;

/**
 * Returns true when the user has opted-in to sharing personal signals with
 * external AI services. Defaults to TRUE on lookup failure so existing flows
 * (moderation, recommendations) keep working — the privacy gate is opt-OUT.
 */
export async function aiDataSharingEnabled(userId: string): Promise<boolean> {
  if (!userId) return true;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data } = await supabase
      .from("privacy_settings")
      .select("ai_data_sharing_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return true;
    return data.ai_data_sharing_enabled !== false;
  } catch (err) {
    console.warn("[ai-privacy] lookup failed, defaulting to enabled:", err);
    return true;
  }
}

/**
 * Truncate + strip obvious PII from a free-form text snippet before it is sent
 * to an external AI service. Safe to call on any string (always returns a string).
 */
export function sanitizeForAI(text: string | null | undefined, maxLen = MAX_BODY_PREVIEW): string {
  if (!text) return "";
  let s = String(text);
  // Strip emails
  s = s.replace(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
  // Strip long digit sequences (phones, IDs, card numbers)
  s = s.replace(/\b\d{8,}\b/g, "[number]");
  // Strip URLs with tokens / queries (keep host only)
  s = s.replace(/https?:\/\/([^\s/]+)\/\S*/g, "https://$1/…");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}
