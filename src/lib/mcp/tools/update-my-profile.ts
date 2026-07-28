import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, jsonResult, notAuthenticated, supabaseForUser } from "../supabase";

export default defineTool({
  name: "update_my_profile",
  title: "Update my ForSure profile",
  description: "Update editable fields of the signed-in user's ForSure profile. Only provided fields change.",
  inputSchema: {
    name: z.string().trim().min(1).max(80).nullable().optional().describe("Display name."),
    bio: z.string().trim().max(500).nullable().optional().describe("Short biography."),
    city: z.string().trim().max(120).nullable().optional().describe("City shown on the profile."),
    website_url: z.string().trim().url().max(300).nullable().optional().describe("Public website URL."),
    mood_emoji: z.string().trim().max(8).nullable().optional().describe("Mood emoji."),
    mood_text: z.string().trim().max(120).nullable().optional().describe("Short mood text."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated();

    const patch: Record<string, unknown> = {};
    for (const key of ["name", "bio", "city", "website_url", "mood_emoji", "mood_text"] as const) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) return errorResult("Aucun champ à mettre à jour.");
    if ("mood_emoji" in patch || "mood_text" in patch) patch.mood_updated_at = new Date().toISOString();

    const { data, error } = await supabaseForUser(ctx)
      .from("profiles")
      .update(patch)
      .eq("user_id", ctx.getUserId())
      .select("id, name, bio, city, website_url, mood_emoji, mood_text")
      .maybeSingle();

    if (error) return errorResult(error.message);
    if (!data) return errorResult("Profil introuvable ou mise à jour refusée.");
    return jsonResult({ profile: data });
  },
});
