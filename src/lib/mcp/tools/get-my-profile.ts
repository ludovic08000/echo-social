import { defineTool } from "@lovable.dev/mcp-js";
import { errorResult, jsonResult, notAuthenticated, supabaseForUser } from "../supabase";

export default defineTool({
  name: "get_my_profile",
  title: "Get my ForSure profile",
  description: "Read the signed-in user's ForSure profile (name, bio, city, mood, creator status).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated();
    const { data, error } = await supabaseForUser(ctx)
      .from("profiles")
      .select("id, user_id, name, bio, city, website_url, mood_emoji, mood_text, is_creator, creator_tier, created_at")
      .eq("user_id", ctx.getUserId())
      .maybeSingle();
    if (error) return errorResult(error.message);
    if (!data) return errorResult("Aucun profil trouvé pour ce compte.");
    return jsonResult({ profile: data });
  },
});
