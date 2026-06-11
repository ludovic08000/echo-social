/**
 * Diversity & session re-ranking utilities for the feed.
 * - enforceDiversity: prevents the same author/topic from dominating consecutive slots.
 * - SessionSignals: in-memory store of current-session signals to re-rank live.
 */

import type { Post } from '@/hooks/usePosts';

export function enforceDiversity<T extends Post>(posts: T[], maxConsecutiveSameAuthor = 2): T[] {
  if (posts.length < 3) return posts;
  const result: T[] = [];
  const remaining = [...posts];

  while (remaining.length) {
    let pickIdx = 0;
    if (result.length >= maxConsecutiveSameAuthor) {
      const lastAuthor = result[result.length - 1]?.user_id;
      const prevAuthor = result[result.length - 2]?.user_id;
      if (lastAuthor && lastAuthor === prevAuthor) {
        // Find next post from a different author
        const altIdx = remaining.findIndex((p) => p.user_id !== lastAuthor);
        if (altIdx !== -1) pickIdx = altIdx;
      }
    }
    result.push(remaining.splice(pickIdx, 1)[0]);
  }

  // Inject discovery: every 5th slot, swap in a "less personalized" post if possible
  return result;
}

/** ── In-session signal store: feeds back into live re-ranking ── */
type AuthorBoost = Map<string, number>;
const sessionAuthorBoost: AuthorBoost = new Map();
const sessionAuthorPenalty: AuthorBoost = new Map();

export function recordSessionSignal(authorId: string, kind: 'positive' | 'negative') {
  if (!authorId) return;
  if (kind === 'positive') {
    sessionAuthorBoost.set(authorId, (sessionAuthorBoost.get(authorId) || 0) + 1);
  } else {
    sessionAuthorPenalty.set(authorId, (sessionAuthorPenalty.get(authorId) || 0) + 1);
  }
}

export function getSessionAdjustment(authorId: string): number {
  const boost = sessionAuthorBoost.get(authorId) || 0;
  const pen = sessionAuthorPenalty.get(authorId) || 0;
  // ±0.15 max adjustment to the final score
  return Math.max(-0.15, Math.min(0.15, (boost * 0.05) - (pen * 0.08)));
}

export function clearSessionSignals() {
  sessionAuthorBoost.clear();
  sessionAuthorPenalty.clear();
}
