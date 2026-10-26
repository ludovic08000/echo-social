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
 * external AI services. An unavailable preference never authorizes sharing.
 */
export async function aiDataSharingEnabled(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data, error } = await supabase
      .from("privacy_settings")
      .select("ai_data_sharing_enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    return data.ai_data_sharing_enabled === true;
  } catch (err) {
    console.warn("[ai-privacy] lookup unavailable; personal sharing disabled");
    return false;
  }
}

/** Only already-authorized posts whose authors allow external AI sharing. */
export async function aiShareablePosts(db: any, posts: any[]): Promise<any[]> {
  const ids=[...new Set(posts.map(post=>post.user_id).filter(Boolean))];
  if(!ids.length)return [];
  const {data,error}=await db.from("privacy_settings").select("user_id,ai_data_sharing_enabled").in("user_id",ids);
  if(error)return [];
  const allowed=new Set((data??[]).filter((row:any)=>row.ai_data_sharing_enabled===true).map((row:any)=>row.user_id));
  return posts.filter(post=>allowed.has(post.user_id));
}

/** Re-check current public eligibility immediately before an external training batch. */
export async function publicTrainingPosts(db:any,posts:any[]):Promise<any[]>{
  if(!posts.length)return [];
  const {data:current,error}=await db.from("posts").select("id,user_id,subscriber_only,publish_at,expires_at")
    .in("id",posts.map(post=>post.id));
  if(error||!current?.length)return [];
  const ids=[...new Set(current.map((post:any)=>post.user_id))];
  const prefs=await db.from("privacy_settings").select("user_id,ai_data_sharing_enabled,ai_personalization_enabled,profile_visibility,posts_visibility").in("user_id",ids);
  if(prefs.error)return [];
  const allowed=new Set((prefs.data??[]).filter((p:any)=>p.ai_data_sharing_enabled===true&&p.ai_personalization_enabled===true
    &&p.profile_visibility==="public"&&p.posts_visibility==="public").map((p:any)=>p.user_id));
  const now=Date.now();
  const currentIds=new Set(current.filter((post:any)=>allowed.has(post.user_id)&&post.subscriber_only!==true
    &&(!post.publish_at||Date.parse(post.publish_at)<=now)&&(!post.expires_at||Date.parse(post.expires_at)>now)).map((post:any)=>post.id));
  return posts.filter(post=>currentIds.has(post.id));
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
