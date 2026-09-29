import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  evaluateMmrShadow,
  parsePgVector,
  semanticMmrRerank,
  type SemanticCandidate,
} from '../../../supabase/functions/_shared/semantic-mmr';

describe('semantic MMR shadow experiment', () => {
  const candidates: SemanticCandidate[] = [
    { id: 'a1', authorId: 'a', relevance: 1, embedding: [1, 0] },
    { id: 'a2', authorId: 'a', relevance: 0.9, embedding: [0.999, 0.001] },
    { id: 'b1', authorId: 'b', relevance: 0.8, embedding: [0, 1] },
  ];

  it('prefers a semantically different item when diversity has enough weight', () => {
    const reranked = semanticMmrRerank(candidates, 2, 0.5);
    expect(reranked.map((candidate) => candidate.id)).toEqual(['a1', 'b1']);

    const metrics = evaluateMmrShadow(candidates, reranked, 2);
    expect(metrics.topKOverlapPct).toBe(50);
    expect(metrics.mmrDistinctAuthorRatio).toBeGreaterThan(metrics.baselineDistinctAuthorRatio);
    expect(metrics.mmrPairwiseSimilarity).toBeLessThan(metrics.baselinePairwiseSimilarity!);
  });

  it('parses pgvector values and keeps similarity numerically bounded', () => {
    expect(parsePgVector('[1,0,0]')).toEqual([1, 0, 0]);
    expect(parsePgVector('not-a-vector')).toBeNull();
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('does not invent semantic ordering when vectors are unavailable', () => {
    const withoutVectors = candidates.map((candidate) => ({ ...candidate, embedding: null }));
    expect(semanticMmrRerank(withoutVectors, 2, 0.5).map((candidate) => candidate.id))
      .toEqual(['a1', 'a2']);
  });
});
