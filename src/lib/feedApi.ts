import { supabase } from '@/integrations/supabase/client';
import type { FeedRequest, FeedPreferences, FeedEvent } from '../../supabase/functions/_shared/feed-api-contract';
export type { FeedPreferences } from '../../supabase/functions/_shared/feed-api-contract';

const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'Requête de feed invalide.',
  UNAUTHORIZED: 'Connectez-vous pour accéder au feed.',
  SESSION_CHANGED: 'La session a changé. Actualisez le feed.',
  FORBIDDEN: 'Accès au feed refusé.',
  FEED_CURSOR_EXPIRED: 'Actualisez le feed pour continuer.',
  RATE_LIMITED: 'Trop de requêtes. Réessayez dans quelques instants.',
  FEED_UNAVAILABLE: 'Le feed est temporairement indisponible.',
};

export class FeedApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'FEED_UNAVAILABLE';
    super(MESSAGES[safeCode]);
    this.name = 'FeedApiError';
    this.code = safeCode;
  }
}

async function requestFeed(input: FeedRequest, expectedUserId: string | null): Promise<Record<string, unknown>> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new FeedApiError('FEED_UNAVAILABLE');
  const session = sessionData.session;
  // Don't put another account's response into the old account's React Query cache.
  if ((session?.user.id ?? null) !== expectedUserId) throw new FeedApiError('SESSION_CHANGED');
  const token = session?.access_token ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const { data, error } = await supabase.functions.invoke('feed-api', {
      body: input, headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    if (error) {
      let code = 'FEED_UNAVAILABLE';
      // Only the finite public error code crosses the API boundary, never SQL/provider errors.
      if (error.context instanceof Response) {
        try { code = (await error.context.json())?.error?.code ?? code; } catch { /* non-JSON gateway failure */ }
      }
      throw new FeedApiError(code);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new FeedApiError('FEED_UNAVAILABLE');
    return data;
  } catch (error) {
    if (error instanceof FeedApiError) throw error;
    throw new FeedApiError('FEED_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

export function fetchFeedPage(cursor: string | null, limit: number, viewerId: string | null) {
  return requestFeed({ action: 'page', cursor, limit }, viewerId);
}

export async function sendFeedEvents(events: FeedEvent[], viewerId: string): Promise<void> {
  await requestFeed({ action: 'events', events }, viewerId);
}

export async function readFeedPreferences(viewerId: string): Promise<FeedPreferences | null> {
  const data = await requestFeed({ action: 'preferences.read' }, viewerId);
  return data.preferences as FeedPreferences | null;
}

export async function writeFeedPreferences(viewerId: string, preferences: FeedPreferences, seedOnly = false): Promise<FeedPreferences> {
  const data = await requestFeed({ action: seedOnly ? 'preferences.seed' : 'preferences.write', preferences }, viewerId);
  if (!data.preferences) throw new FeedApiError('FEED_UNAVAILABLE');
  return data.preferences as FeedPreferences;
}
