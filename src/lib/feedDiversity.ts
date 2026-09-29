/**
 * Diversity & session re-ranking utilities for the feed.
 * - enforceDiversity: prevents the same author/topic from dominating consecutive slots.
 * - SessionSignals: in-memory store of current-session signals to re-rank live.
 */

interface AuthoredFeedItem {
  user_id: string;
}

export function enforceDiversity<T extends AuthoredFeedItem>(
  posts: T[],
  maxConsecutiveSameAuthor = 2,
  precedingAuthorIds: string[] = [],
): T[] {
  if (posts.length < 2 || maxConsecutiveSameAuthor < 1) return posts;
  const result: T[] = [];
  const remaining = [...posts];
  const recentAuthors = precedingAuthorIds.slice(-maxConsecutiveSameAuthor);

  while (remaining.length) {
    let pickIdx = 0;
    const authorHistory = [...recentAuthors, ...result.map((post) => post.user_id)];
    const lastAuthor = authorHistory[authorHistory.length - 1];
    let consecutive = 0;
    for (let index = authorHistory.length - 1; index >= 0; index -= 1) {
      if (authorHistory[index] !== lastAuthor) break;
      consecutive += 1;
    }
    if (lastAuthor && consecutive >= maxConsecutiveSameAuthor) {
      const alternativeIndex = remaining.findIndex((post) => post.user_id !== lastAuthor);
      if (alternativeIndex !== -1) pickIdx = alternativeIndex;
    }
    result.push(remaining.splice(pickIdx, 1)[0]);
  }

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
