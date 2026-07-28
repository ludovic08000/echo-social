import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, jsonResult, notAuthenticated, supabaseForUser } from "../supabase";

export default defineTool({
  name: "create_post",
  title: "Publish a ForSure post",
  description:
    "Publish a text post (optionally with an image URL) on the signed-in user's ForSure feed. Can also be scheduled for later.",
  inputSchema: {
    body: z.string().trim().min(1).max(5000).describe("The post text."),
    image_url: z.string().trim().url().max(1000).nullable().optional().describe("Optional image URL to attach."),
    publish_at: z
      .string()
      .trim()
      .nullable()
      .optional()
      .describe("Optional ISO 8601 datetime to schedule the post instead of publishing immediately."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async ({ body, image_url, publish_at }, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated();

    let scheduledAt: string | null = null;
    if (publish_at) {
      const parsed = new Date(publish_at);
      if (Number.isNaN(parsed.getTime())) return errorResult("publish_at n'est pas une date ISO valide.");
      scheduledAt = parsed.toISOString();
    }

    const { data, error } = await supabaseForUser(ctx)
      .from("posts")
      .insert({
        user_id: ctx.getUserId(),
        body,
        image_url: image_url ?? null,
        ...(scheduledAt ? { publish_at: scheduledAt } : {}),
      })
      .select("id, body, image_url, created_at, publish_at")
      .single();

    if (error) return errorResult(error.message);
    return jsonResult({ post: data, scheduled: Boolean(scheduledAt) });
  },
});
