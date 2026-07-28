import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, jsonResult, notAuthenticated, supabaseForUser } from "../supabase";

export default defineTool({
  name: "list_my_posts",
  title: "List my ForSure posts",
  description: "List the signed-in user's most recent ForSure posts with their like and comment counts.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("How many posts to return (default 10)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated();
    const { data, error } = await supabaseForUser(ctx)
      .from("posts")
      .select("id, body, image_url, created_at, publish_at, likes_count, comments_count")
      .eq("user_id", ctx.getUserId())
      .order("created_at", { ascending: false })
      .limit(limit ?? 10);
    if (error) return errorResult(error.message);
    return jsonResult({ count: data?.length ?? 0, posts: data ?? [] });
  },
});
