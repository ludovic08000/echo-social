import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { bubbleDiagnostic } from '@/lib/messaging/bubbleDiagnostics';
import {
  useMessages as useBaseMessages,
  ZEUS_BOT_ID,
  type Message,
} from './useMessages';

export * from './useMessages';

const PAGE_SIZE = 120;
const OPTIMISTIC_TTL_MS = 10 * 60_000;
const optimisticByConversation = new Map<string, Message[]>();

type Cursor = { createdAt: string; id: string };
type OlderPage = {
  messages: Message[];
  nextCursor?: Cursor;
};

function normalizeUrl(value: string | null | undefined): string | null {
  return value || null;
}

function messageTime(message: Pick<Message, 'created_at'>): number {
  const value = new Date(message.created_at).getTime();
  return Number.isFinite(value) ? value : 0;
}

function sameAcknowledgedMessage(optimistic: Message, real: Message): boolean {
  if (real.id.startsWith('optimistic-')) return false;
  if (optimistic.sender_id !== real.sender_id) return false;
  if (optimistic.body !== real.body) return false;
  if (normalizeUrl(optimistic.image_url) !== normalizeUrl(real.image_url)) return false;
  return Math.abs(messageTime(real) - messageTime(optimistic)) <= 5 * 60_000;
}

function rememberOptimistics(conversationId: string, messages: Message[]): Message[] {
  const now = Date.now();
  const remembered = optimisticByConversation.get(conversationId) ?? [];
  const combined = new Map<string, Message>();

  for (const message of remembered) {
    if (now - messageTime(message) <= OPTIMISTIC_TTL_MS) combined.set(message.id, message);
  }
  for (const message of messages) {
    if (message.id.startsWith('optimistic-')) combined.set(message.id, message);
  }

  const current = [...combined.values()];
  if (current.length > 0) optimisticByConversation.set(conversationId, current);
  else optimisticByConversation.delete(conversationId);
  return current;
}

function mergeMessages(
  conversationId: string,
  recent: Message[],
  older: Message[],
): Message[] {
  const realMessages = [...older, ...recent].filter((message) => !message.id.startsWith('optimistic-'));
  const remembered = rememberOptimistics(conversationId, recent);

  bubbleDiagnostic('MERGE_START', {
    conversationId,
    details: {
      recentCount: recent.length,
      olderCount: older.length,
      realCount: realMessages.length,
      optimisticCount: remembered.length,
    },
  });

  const unmatchedOptimistics = remembered.filter((optimistic) => {
    const acknowledgedBy = realMessages.find((real) => sameAcknowledgedMessage(optimistic, real));
    if (acknowledgedBy) {
      bubbleDiagnostic('OPTIMISTIC_ACK_MATCH', {
        conversationId,
        messageId: acknowledgedBy.id,
        localId: optimistic.id,
        reason: 'same_sender_body_media_within_ack_window',
        details: {
          optimisticCreatedAt: optimistic.created_at,
          serverCreatedAt: acknowledgedBy.created_at,
          hasMedia: Boolean(optimistic.image_url),
        },
      });
      return false;
    }
    bubbleDiagnostic('OPTIMISTIC_RETAINED', {
      conversationId,
      localId: optimistic.id,
      reason: 'no_matching_server_ack',
      details: {
        ageMs: Date.now() - messageTime(optimistic),
        hasMedia: Boolean(optimistic.image_url),
      },
    });
    return true;
  });

  if (unmatchedOptimistics.length > 0) {
    optimisticByConversation.set(conversationId, unmatchedOptimistics);
  } else {
    optimisticByConversation.delete(conversationId);
  }

  const byId = new Map<string, Message>();
  for (const message of [...realMessages, ...unmatchedOptimistics]) byId.set(message.id, message);

  const merged = [...byId.values()].sort((a, b) => {
    const delta = messageTime(a) - messageTime(b);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

  bubbleDiagnostic('MERGE_RESULT', {
    conversationId,
    details: {
      mergedCount: merged.length,
      serverCount: realMessages.length,
      retainedOptimisticCount: unmatchedOptimistics.length,
      firstId: merged[0]?.id ?? null,
      lastId: merged[merged.length - 1]?.id ?? null,
    },
  });
  return merged;
}

async function fetchOlderPage(
  conversationId: string,
  cursor: Cursor,
  hiddenIds: Set<string>,
): Promise<OlderPage> {
  const query = (supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .in('status', ['delivered', 'pending']) as any)
    .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as Array<Omit<Message, 'profile'>>;
  const visibleRows = rows.filter((row) => !hiddenIds.has(row.id));
  const senderIds = [...new Set(visibleRows.map((row) => row.sender_id))];

  const { data: profiles } = senderIds.length > 0
    ? await supabase.from('profiles').select('user_id, name, avatar_url').in('user_id', senderIds)
    : { data: [] as Array<{ user_id: string; name: string; avatar_url: string | null }> };
  const profileMap = new Map((profiles ?? []).map((profile) => [profile.user_id, profile]));

  const messages = visibleRows.map((row) => ({
    ...row,
    profile: {
      name: row.sender_id === ZEUS_BOT_ID
        ? 'Zeus ⚡'
        : (profileMap.get(row.sender_id)?.name || 'Unknown'),
      avatar_url: profileMap.get(row.sender_id)?.avatar_url || null,
    },
  })) as Message[];

  const oldestRaw = rows[rows.length - 1];
  return {
    messages,
    nextCursor: rows.length === PAGE_SIZE && oldestRaw
      ? { createdAt: oldestRaw.created_at, id: oldestRaw.id }
      : undefined,
  };
}

export function useMessages(conversationId: string) {
  const { user } = useAuth();
  const base = useBaseMessages(conversationId);
  const recent = base.data ?? [];
  const oldestRecent = recent.find((message) => !message.id.startsWith('optimistic-'));
  const anchor = oldestRecent
    ? { createdAt: oldestRecent.created_at, id: oldestRecent.id }
    : null;

  const hiddenQuery = useQuery({
    queryKey: ['message-hidden-ids', conversationId, user?.id ?? 'anon'],
    enabled: Boolean(conversationId && user),
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('message_deletions')
        .select('message_id')
        .eq('user_id', user!.id);
      if (error) throw error;
      return new Set((data ?? []).map((row) => row.message_id));
    },
  });
  const hiddenIds = hiddenQuery.data ?? new Set<string>();

  const olderQuery = useInfiniteQuery({
    queryKey: [
      'messages-older',
      conversationId,
      user?.id ?? 'anon',
      anchor?.createdAt ?? 'none',
      anchor?.id ?? 'none',
      [...hiddenIds].sort().join(','),
    ],
    enabled: Boolean(conversationId && user && anchor && recent.length >= PAGE_SIZE),
    initialPageParam: anchor as Cursor,
    queryFn: ({ pageParam }) => fetchOlderPage(conversationId, pageParam, hiddenIds),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const older = useMemo(
    () => olderQuery.data?.pages.flatMap((page) => page.messages) ?? [],
    [olderQuery.data],
  );
  const data = useMemo(
    () => mergeMessages(conversationId, recent, older),
    [conversationId, recent, older],
  );

  const previousIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const previousIds = previousIdsRef.current;
    const currentIds = data.map((message) => message.id);
    const previousSet = new Set(previousIds);
    const currentSet = new Set(currentIds);

    for (const id of currentIds) {
      if (!previousSet.has(id)) {
        const message = data.find((entry) => entry.id === id);
        bubbleDiagnostic('MESSAGE_ADDED', {
          conversationId,
          messageId: id.startsWith('optimistic-') ? undefined : id,
          localId: id.startsWith('optimistic-') ? id : undefined,
          reason: id.startsWith('optimistic-') ? 'optimistic_entered_render_list' : 'server_message_entered_render_list',
          details: {
            index: currentIds.indexOf(id),
            total: currentIds.length,
            hasMedia: Boolean(message?.image_url),
            status: message?.status ?? null,
          },
        });
      }
    }

    for (const id of previousIds) {
      if (!currentSet.has(id)) {
        bubbleDiagnostic('MESSAGE_REMOVED', {
          conversationId,
          messageId: id.startsWith('optimistic-') ? undefined : id,
          localId: id.startsWith('optimistic-') ? id : undefined,
          reason: hiddenIds.has(id)
            ? 'local_deletion_policy'
            : id.startsWith('optimistic-')
              ? 'optimistic_removed_or_acknowledged'
              : 'missing_from_merged_query_result',
          details: {
            previousIndex: previousIds.indexOf(id),
            previousTotal: previousIds.length,
            currentTotal: currentIds.length,
            baseRecentCount: recent.length,
            olderCount: older.length,
          },
        });
      }
    }

    const shared = currentIds.filter((id) => previousSet.has(id));
    const reordered = shared.filter((id) => previousIds.indexOf(id) !== currentIds.indexOf(id));
    if (reordered.length > 0) {
      bubbleDiagnostic('MESSAGE_REORDERED', {
        conversationId,
        reason: 'stable_ids_changed_render_index',
        details: {
          count: reordered.length,
          sampleIds: reordered.slice(0, 10),
        },
      });
    }

    previousIdsRef.current = currentIds;
  }, [conversationId, data, hiddenIds, older.length, recent.length]);

  const pendingScrollRef = useRef<{ element: HTMLElement; height: number } | null>(null);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement)) return;
      if (element.scrollTop > 180) return;
      if (!olderQuery.hasNextPage || olderQuery.isFetchingNextPage) return;

      pendingScrollRef.current = { element, height: element.scrollHeight };
      void olderQuery.fetchNextPage().then(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const pending = pendingScrollRef.current;
          if (!pending || pending.element !== element) return;
          const delta = element.scrollHeight - pending.height;
          if (delta > 0) element.scrollTop += delta;
          pendingScrollRef.current = null;
        }));
      });
    };

    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [olderQuery.fetchNextPage, olderQuery.hasNextPage, olderQuery.isFetchingNextPage]);

  return {
    ...base,
    data,
    fetchNextPage: olderQuery.fetchNextPage,
    hasNextPage: olderQuery.hasNextPage,
    isFetchingNextPage: olderQuery.isFetchingNextPage,
  };
}

export const __test__ = {
  mergeMessages,
  sameAcknowledgedMessage,
};
