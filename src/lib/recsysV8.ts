export type FeedSignalType =
  | 'view'
  | 'dwell_medium'
  | 'dwell_long'
  | 'watch_complete'
  | 'like'
  | 'comment'
  | 'share'
  | 'save'
  | 'not_interested'
  | 'hide'
  | 'report'
  | 'skip_fast'
  | 'click';

export interface FeedRpcRow {
  id: string;
  user_id: string;
  body: string | null;
  image_url: string | null;
  created_at: string;
  expires_at?: string | null;
  likes_count?: number | null;
  comments_count?: number | null;
  author_name?: string | null;
  author_avatar?: string | null;
  author_mood?: string | null;
  user_reaction?: string | null;
  is_friend?: boolean | null;
  final_score?: number | string | null;
  rank_reason?: string | null;
  experiment_variant?: 'a' | 'b' | string | null;
}

export interface FeedPostView {
  id: string;
  user_id: string;
  body: string;
  image_url: string | null;
  created_at: string;
  expires_at?: string | null;
  profile: {
    name: string;
    avatar_url: string | null;
    mood_emoji?: string | null;
  };
  likes_count: number;
  comments_count: number;
  is_liked: boolean;
  user_reaction?: string | null;
  rank_reason?: string | null;
  final_score?: number;
  experiment_variant?: string | null;
}

export interface FeedExperimentEvent {
  post_id: string;
  event_type: FeedSignalType;
  surface: 'feed' | 'video' | 'live' | string;
  dwell_ms?: number;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export function mapFeedRpcRow(row: FeedRpcRow): FeedPostView {
  const score = Number(row.final_score);
  return {
    id: row.id,
    user_id: row.user_id,
    body: row.body || '',
    image_url: row.image_url || null,
    created_at: row.created_at,
    expires_at: row.expires_at || null,
    profile: {
      name: row.author_name || 'Utilisateur',
      avatar_url: row.author_avatar || null,
      mood_emoji: row.author_mood || null,
    },
    likes_count: Number(row.likes_count || 0),
    comments_count: Number(row.comments_count || 0),
    is_liked: !!row.user_reaction,
    user_reaction: row.user_reaction || null,
    rank_reason: row.rank_reason || null,
    final_score: Number.isFinite(score) ? score : undefined,
    experiment_variant: row.experiment_variant || null,
  };
}

export function buildFeedExperimentEvent(params: {
  postId: string;
  signal: FeedSignalType;
  dwellMs?: number;
  weight?: number;
  surface?: string;
}): FeedExperimentEvent | null {
  if (!params.postId) return null;
  return {
    post_id: params.postId,
    event_type: params.signal,
    surface: params.surface || 'feed',
    ...(Number.isFinite(params.dwellMs) ? { dwell_ms: Math.max(0, Math.round(params.dwellMs as number)) } : {}),
    ...(Number.isFinite(params.weight) ? { weight: params.weight } : {}),
  };
}

export function capExperimentEventBatch(events: FeedExperimentEvent[], max = 100): FeedExperimentEvent[] {
  return events
    .filter((event) => !!event.post_id && !!event.event_type)
    .slice(0, Math.max(0, max));
}
