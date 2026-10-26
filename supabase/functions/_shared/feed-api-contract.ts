// Public contract only: no model weights, database schema or provider credentials.
export interface FeedPreferences {
  feed_algorithm: 'smart' | 'chronological' | 'friends_first';
  ai_summaries_enabled: boolean;
  auto_translate_enabled: boolean;
  diversity_boost: number;
  muted_keywords: string[];
  priority_topics: string[];
  viral_content_reduce: boolean;
  sensitive_content_filter: boolean;
  seen_posts_hide: boolean;
  weight_friends: number;
  weight_discovery: number;
  weight_news: number;
  weight_marketplace: number;
}

export interface FeedEvent {
  event_id: string;
  post_id: string;
  exposure_id: string;
  event_type: string;
  dwell_ms?: number;
}

export type FeedRequest =
  | { action: 'page'; limit: number; cursor: string | null }
  | { action: 'events'; events: FeedEvent[] }
  | { action: 'preferences.read' }
  | { action: 'preferences.write' | 'preferences.seed'; preferences: FeedPreferences };

export const PREFERENCE_FIELDS = [
  'feed_algorithm', 'ai_summaries_enabled', 'auto_translate_enabled', 'diversity_boost',
  'muted_keywords', 'priority_topics', 'viral_content_reduce', 'sensitive_content_filter',
  'seen_posts_hide', 'weight_friends', 'weight_discovery', 'weight_news', 'weight_marketplace',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNALS = new Set(['view', 'dwell_medium', 'dwell_long', 'watch_complete', 'like',
  'comment', 'share', 'save', 'not_interested', 'hide', 'report', 'skip_fast', 'click']);

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('INVALID_REQUEST');
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseFeedPreferences(value: unknown): FeedPreferences {
  const p = object(value);
  exactKeys(p, PREFERENCE_FIELDS);
  if (typeof p.feed_algorithm !== 'string' || !['smart', 'chronological', 'friends_first'].includes(p.feed_algorithm)) throw new Error('INVALID_REQUEST');
  for (const key of ['diversity_boost', 'weight_friends', 'weight_discovery', 'weight_news', 'weight_marketplace']) {
    if (!integer(p[key], 0, 100)) throw new Error('INVALID_REQUEST');
  }
  for (const key of ['ai_summaries_enabled', 'auto_translate_enabled', 'viral_content_reduce', 'sensitive_content_filter', 'seen_posts_hide']) {
    if (typeof p[key] !== 'boolean') throw new Error('INVALID_REQUEST');
  }
  for (const key of ['muted_keywords', 'priority_topics']) {
    if (!Array.isArray(p[key]) || p[key].length > 100 || p[key].some((s: unknown) => typeof s !== 'string' || s.length > 100)) {
      throw new Error('INVALID_REQUEST');
    }
  }
  return p as unknown as FeedPreferences;
}

export function parseFeedRequest(value: unknown): FeedRequest {
  const body = object(value);
  switch (body.action) {
    case 'page': {
      exactKeys(body, ['action', 'limit', 'cursor']);
      const limit = body.limit ?? 12;
      const cursor = body.cursor ?? null;
      if (!integer(limit, 1, 50) || (cursor !== null && (typeof cursor !== 'string' || !UUID.test(cursor)))) {
        throw new Error('INVALID_REQUEST');
      }
      return { action: 'page', limit, cursor: cursor as string | null };
    }
    case 'events': {
      exactKeys(body, ['action', 'events']);
      if (!Array.isArray(body.events) || body.events.length > 100) throw new Error('INVALID_REQUEST');
      for (const value of body.events) {
        const event = object(value);
        exactKeys(event, ['event_id', 'post_id', 'exposure_id', 'event_type', 'dwell_ms']);
        for (const key of ['event_id', 'post_id', 'exposure_id']) {
          if (typeof event[key] !== 'string' || !UUID.test(event[key])) throw new Error('INVALID_REQUEST');
        }
        if (typeof event.event_type !== 'string' || !SIGNALS.has(event.event_type)
            || (event.dwell_ms !== undefined && !integer(event.dwell_ms, 0, 600000))) {
          throw new Error('INVALID_REQUEST');
        }
      }
      return body as unknown as FeedRequest;
    }
    case 'preferences.read':
      exactKeys(body, ['action']);
      return { action: body.action };
    case 'preferences.write':
    case 'preferences.seed':
      exactKeys(body, ['action', 'preferences']);
      return { action: body.action, preferences: parseFeedPreferences(body.preferences) };
    default: throw new Error('INVALID_REQUEST');
  }
}

const POST_FIELDS = ['id', 'user_id', 'body', 'image_url', 'media_thumbnail_url', 'created_at',
  'expires_at', 'subscriber_only', 'likes_count', 'comments_count', 'author_name', 'author_avatar',
  'author_mood', 'user_reaction', 'exposure_id'] as const;

/** Allowlist, never a spread: newly added internal fields cannot leak by default. */
export function publicFeedPage(value: unknown, limit: number) {
  const page = object(value);
  if (!Array.isArray(page.items) || page.items.length > limit
      || typeof page.has_more !== 'boolean'
      || (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || !UUID.test(page.next_cursor)))
      || typeof page.snapshot_expires_at !== 'string' || !Number.isFinite(Date.parse(page.snapshot_expires_at))
      || (page.has_more && !page.next_cursor)) throw new Error('INVALID_UPSTREAM');
  return {
    items: page.items.map(value => {
      const row = object(value);
      if (typeof row.id !== 'string' || !UUID.test(row.id)) throw new Error('INVALID_UPSTREAM');
      return Object.fromEntries(POST_FIELDS.filter(key => key in row).map(key => [key, row[key]]));
    }),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    snapshot_expires_at: page.snapshot_expires_at,
  };
}

export function publicPreferences(value: unknown): FeedPreferences | null {
  if (value === null) return null;
  const row = object(value);
  return parseFeedPreferences(Object.fromEntries(PREFERENCE_FIELDS.map(key => [key, row[key]])));
}
