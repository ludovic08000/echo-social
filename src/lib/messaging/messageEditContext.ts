import { supabase } from '@/integrations/supabase/client';
import {
  resolveMessageEditPlaintext,
  selectLatestMessageEdit,
  type MessageEditMeta,
  type MessageEditRow,
  type ResolvedMessageEdit,
} from '@/lib/messaging/messageEdits';

export interface MessageEditContext {
  meta: MessageEditMeta | null;
  latest: MessageEditRow | null;
  resolved: ResolvedMessageEdit | null;
}

type Resolver = (context: MessageEditContext) => void;
const waiters = new Map<string, Resolver[]>();
let timer: ReturnType<typeof setTimeout> | null = null;
let activeUserId = '';

function emptyContext(): MessageEditContext {
  return { meta: null, latest: null, resolved: null };
}

async function resolveWithRetry(
  latest: MessageEditRow,
  userId: string,
): Promise<ResolvedMessageEdit | null> {
  const delays = [0, 250, 750, 1_500];
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const text = await resolveMessageEditPlaintext(latest, userId);
    if (text !== null) {
      return {
        editId: latest.id,
        messageId: latest.message_id,
        conversationId: latest.conversation_id,
        revision: latest.revision,
        text,
        editedAt: latest.edited_at,
      };
    }
  }
  return null;
}

async function flush(): Promise<void> {
  timer = null;
  const local = new Map(waiters);
  waiters.clear();
  const ids = [...local.keys()];
  if (!ids.length || !activeUserId) return;

  try {
    const [messageResult, editResult] = await Promise.all([
      supabase
        .from('messages')
        .select('id, conversation_id, sender_id, created_at, image_url, view_once, document_url')
        .in('id', ids),
      (supabase as any)
        .from('message_edits')
        .select('id, message_id, conversation_id, editor_user_id, revision, encrypted_body, archive_body, edited_at, created_at')
        .in('message_id', ids)
        .order('revision', { ascending: false }),
    ]);

    // Older deployments may not have the migration yet. In that case, do not
    // expose a button that can only fail; the rest of messaging remains intact.
    if (messageResult.error || editResult.error) {
      for (const list of local.values()) for (const done of list) done(emptyContext());
      return;
    }

    const meta = new Map<string, MessageEditMeta>();
    for (const row of messageResult.data ?? []) meta.set(row.id, row as MessageEditMeta);

    const grouped = new Map<string, MessageEditRow[]>();
    for (const row of (editResult.data ?? []) as MessageEditRow[]) {
      const rows = grouped.get(row.message_id) ?? [];
      rows.push(row);
      grouped.set(row.message_id, rows);
    }

    await Promise.all(ids.map(async (messageId) => {
      const latest = selectLatestMessageEdit(grouped.get(messageId) ?? []);
      const resolved = latest ? await resolveWithRetry(latest, activeUserId) : null;
      const context = { meta: meta.get(messageId) ?? null, latest, resolved };
      for (const done of local.get(messageId) ?? []) done(context);
    }));
  } catch {
    for (const list of local.values()) for (const done of list) done(emptyContext());
  }
}

export function loadMessageEditContext(
  messageId: string,
  userId: string,
): Promise<MessageEditContext> {
  activeUserId = userId;
  return new Promise((resolve) => {
    const list = waiters.get(messageId) ?? [];
    list.push(resolve);
    waiters.set(messageId, list);
    if (!timer) timer = setTimeout(() => void flush(), 40);
  });
}

export const __test__ = { emptyContext, resolveWithRetry };
