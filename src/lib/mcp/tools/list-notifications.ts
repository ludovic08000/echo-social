import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { errorResult, jsonResult, notAuthenticated, supabaseForUser } from "../supabase";

export default defineTool({
  name: "list_notifications",
  title: "List my ForSure notifications",
  description: "List the signed-in user's recent ForSure notifications, optionally only the unread ones.",
  inputSchema: {
    unread_only: z.boolean().optional().describe("Return only unread notifications (default false)."),
    limit: z.number().int().min(1).max(50).optional().describe("How many notifications to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ unread_only, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated();

    let query = supabaseForUser(ctx)
      .from("notifications")
      .select("id, type, actor_id, post_id, read_at, created_at")
      .eq("user_id", ctx.getUserId())
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);

    if (unread_only) query = query.is("read_at", null);

    const { data, error } = await query;
    if (error) return errorResult(error.message);
    return jsonResult({ count: data?.length ?? 0, notifications: data ?? [] });
  },
});
