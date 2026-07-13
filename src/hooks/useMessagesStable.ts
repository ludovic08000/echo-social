import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
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
  const unmatchedOptimistics = remembered.filter(
    (optimistic) => !realMessages.some((real) => sameAcknowledgedMessage(optimistic, real)),
  );

  if (unmatchedOptimistics.length > 0) {
    optimisticByConversation.set(conversationId, unmatchedOptimistics);
  } else {
    optimisticByConversation.delete(conversationId);
  }

  const byId = new Map<string, Message>();
  for (const message of [...realMessages, ...unmatchedOptimistics]) byId.set(message.id, message);

  return [...byId.values()].sort((a, b) => {
    const delta = messageTime(a) - messageTime(b);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
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

/**
 * Compatibility layer over the existing E2EE/realtime hook.
 *
 * The base hook remains responsible for current-window decryption and realtime
 * delivery. This layer retains unrelated optimistic rows and pages older rows
 * with a deterministic `(created_at,id)` cursor.
 */
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
