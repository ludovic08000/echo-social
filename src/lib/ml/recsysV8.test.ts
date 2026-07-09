import { describe, expect, it } from 'vitest';
import {
  buildFeedExperimentEvent,
  capExperimentEventBatch,
  mapFeedRpcRow,
} from './recsysV8';

describe('recsysV8 helpers', () => {
  it('maps v8 RPC rows to the existing post view shape', () => {
    const post = mapFeedRpcRow({
      id: 'post-1',
      user_id: 'user-1',
      body: null,
      image_url: null,
      created_at: '2026-07-04T10:00:00Z',
      likes_count: 7,
      comments_count: 3,
      author_name: 'Alice',
      author_avatar: 'avatar.png',
      author_mood: 'ok',
      user_reaction: 'like',
      final_score: '82.5',
      rank_reason: 'embedding_match',
      experiment_variant: 'b',
    });

    expect(post.body).toBe('');
    expect(post.profile.name).toBe('Alice');
    expect(post.is_liked).toBe(true);
    expect(post.final_score).toBe(82.5);
    expect(post.rank_reason).toBe('embedding_match');
    expect(post.experiment_variant).toBe('b');
  });

  it('builds bounded A/B telemetry events', () => {
    const event = buildFeedExperimentEvent({
      postId: '123',
      signal: 'watch_complete',
      dwellMs: 1234.56,
      weight: 2.2,
    });

    expect(event).toEqual({
      post_id: '123',
      event_type: 'watch_complete',
      surface: 'feed',
      dwell_ms: 1235,
      weight: 2.2,
    });

    const capped = capExperimentEventBatch(
      Array.from({ length: 150 }, (_, index) => ({
        post_id: String(index),
        event_type: 'view' as const,
        surface: 'feed',
      })),
    );

    expect(capped).toHaveLength(100);
  });
});
