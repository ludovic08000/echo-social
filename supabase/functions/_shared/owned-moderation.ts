type ModerationContent = { id: string | null; kind: 'post' | 'comment'; postId: string | null; text: string; imageUrl: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const response = (cors: Record<string, string>, status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Le navigateur indique un identifiant, pas le contenu faisant autorité pour une sanction. */
export async function ownedModerationContent(db: any, actor: string, kind: 'post' | 'comment', body: any, cors: Record<string, string>): Promise<{ content?: ModerationContent; denial?: Response }> {
  const id = kind === 'post' ? body?.postId : body?.commentId;
  if (kind === 'post' && id == null) {
    if (typeof body?.text !== 'string' || body.text.length > 30000) return { denial: response(cors, 400, 'MODERATION_PREVIEW_INVALID') };
    return { content: { id: null, kind, postId: null, text: body.text, imageUrl: null } };
  }
  if (typeof id !== 'string' || !UUID.test(id)) return { denial: response(cors, 400, 'MODERATION_CONTENT_ID_INVALID') };
  const columns = kind === 'post' ? 'id,user_id,body,image_url' : 'id,user_id,post_id,body,is_zeus_reply';
  const { data, error } = await db.from(kind === 'post' ? 'posts' : 'comments').select(columns).eq('id', id).eq('user_id', actor).maybeSingle();
  if (error) return { denial: response(cors, 503, 'MODERATION_CONTENT_LOOKUP_UNAVAILABLE') };
  if (!data || data.user_id !== actor || (kind === 'comment' && data.is_zeus_reply !== false)) return { denial: response(cors, 404, 'MODERATION_CONTENT_UNAVAILABLE') };
  const postId = kind === 'post' ? data.id : data.post_id;
  if (kind === 'comment' && body.postId != null && body.postId !== postId) return { denial: response(cors, 400, 'MODERATION_POST_MISMATCH') };
  if (typeof data.body !== 'string' && data.body !== null) return { denial: response(cors, 503, 'MODERATION_CONTENT_INVALID') };
  const text = data.body ?? '';
  if (text.length > 30000) return { denial: response(cors, 413, 'MODERATION_CONTENT_TOO_LARGE') };
  return { content: { id: data.id, kind, postId, text, imageUrl: kind === 'post' ? data.image_url : null } };
}

export async function recordOwnedModeration(db: any, actor: string, content: ModerationContent, result: { reason: string; severity: string; category: string; reply: string; reasoning?: string }, cors: Record<string, string>) {
  if (!content.id) return { persisted: false, replayed: false, strike_count: 0, escalated: false, zeus_reply: result.reply,reason:result.reason,severity:result.severity,category:result.category };
  const { data, error } = await db.rpc('apply_owned_content_moderation', {
    p_kind: content.kind, p_content: content.id, p_actor: actor, p_expected_body: content.text,
    p_reason: result.reason, p_severity: result.severity, p_category: result.category, p_reply: result.reply, p_reasoning: result.reasoning ?? '',
  });
  if (error || !data || typeof data.applied !== 'boolean') return { denial: response(cors, 503, 'MODERATION_WRITE_NOT_CONFIRMED') };
  if (!data.applied) return { denial: response(cors, 409, data.reason === 'CONTENT_CHANGED' ? 'MODERATION_CONTENT_CHANGED' : 'MODERATION_CONTENT_UNAVAILABLE') };
  if (!Number.isSafeInteger(data.strike_count) || data.strike_count < 1 || typeof data.replayed !== 'boolean' || typeof data.escalated !== 'boolean' || typeof data.zeus_reply !== 'string'
    ||typeof data.reason!=='string'||typeof data.severity!=='string'||typeof data.category!=='string') return { denial: response(cors, 503, 'MODERATION_WRITE_NOT_CONFIRMED') };
  return { persisted: true, replayed: data.replayed as boolean, strike_count: data.strike_count as number, escalated: data.escalated as boolean, zeus_reply: data.zeus_reply as string,
    reason:data.reason as string,severity:data.severity as string,category:data.category as string };
}
