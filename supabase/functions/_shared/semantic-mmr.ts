export interface SemanticCandidate {
  id: string;
  authorId: string;
  relevance: number;
  embedding: number[] | null;
}

export interface MmrEvaluation {
  topKOverlapPct: number;
  baselineDistinctAuthorRatio: number;
  mmrDistinctAuthorRatio: number;
  baselinePairwiseSimilarity: number | null;
  mmrPairwiseSimilarity: number | null;
  meanRelevanceDelta: number;
  semanticCoveragePct: number;
}

function isUsableEmbedding(value: number[] | null): value is number[] {
  return !!value
    && value.length > 0
    && value.every((component) => Number.isFinite(component));
}

export function parsePgVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const parsed = value.map(Number);
    return isUsableEmbedding(parsed) ? parsed : null;
  }
  if (typeof value !== 'string' || value.length < 3) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const numeric = parsed.map(Number);
    return isUsableEmbedding(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

/**
 * Deterministic Maximal Marginal Relevance reranker used only by the shadow
 * experiment. Candidates without semantic vectors retain their baseline order
 * after the vector-covered candidates, so missing data is visible in metrics
 * instead of silently receiving an artificial diversity advantage.
 */
export function semanticMmrRerank(
  candidates: SemanticCandidate[],
  limit = 20,
  lambda = 0.82,
): SemanticCandidate[] {
  const safeLimit = Math.max(0, Math.min(limit, candidates.length));
  if (safeLimit === 0) return [];

  const boundedLambda = Math.max(0, Math.min(1, lambda));
  const indexed = candidates.map((candidate, index) => ({ candidate, index }));
  const eligible = indexed.filter(({ candidate }) => isUsableEmbedding(candidate.embedding));
  if (eligible.length < 2) return candidates.slice(0, safeLimit);

  const relevanceValues = eligible.map(({ candidate }) => Number(candidate.relevance) || 0);
  const minRelevance = Math.min(...relevanceValues);
  const maxRelevance = Math.max(...relevanceValues);
  const relevanceRange = Math.max(1e-9, maxRelevance - minRelevance);
  const selected: typeof eligible = [];
  const remaining = [...eligible];

  while (remaining.length > 0 && selected.length < safeLimit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const entry = remaining[index];
      const normalizedRelevance = ((Number(entry.candidate.relevance) || 0) - minRelevance) / relevanceRange;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        maxSimilarity = Math.max(
          maxSimilarity,
          cosineSimilarity(entry.candidate.embedding!, chosen.candidate.embedding!),
        );
      }
      const score = boundedLambda * normalizedRelevance - (1 - boundedLambda) * maxSimilarity;
      const currentBest = remaining[bestIndex];
      if (
        score > bestScore
        || (score === bestScore && entry.index < currentBest.index)
      ) {
        bestIndex = index;
        bestScore = score;
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  const selectedIds = new Set(selected.map(({ candidate }) => candidate.id));
  const output = selected.map(({ candidate }) => candidate);
  for (const candidate of candidates) {
    if (output.length >= safeLimit) break;
    if (!selectedIds.has(candidate.id)) output.push(candidate);
  }
  return output;
}

function distinctAuthorRatio(items: SemanticCandidate[]): number {
  if (items.length === 0) return 0;
  return new Set(items.map((item) => item.authorId)).size / items.length;
}

function meanPairwiseSimilarity(items: SemanticCandidate[]): number | null {
  let sum = 0;
  let pairs = 0;
  for (let left = 0; left < items.length; left += 1) {
    if (!isUsableEmbedding(items[left].embedding)) continue;
    for (let right = left + 1; right < items.length; right += 1) {
      if (!isUsableEmbedding(items[right].embedding)) continue;
      if (items[left].embedding!.length !== items[right].embedding!.length) continue;
      sum += cosineSimilarity(items[left].embedding!, items[right].embedding!);
      pairs += 1;
    }
  }
  return pairs > 0 ? sum / pairs : null;
}

function meanRelevance(items: SemanticCandidate[]): number {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + (Number(item.relevance) || 0), 0) / items.length;
}

export function evaluateMmrShadow(
  candidates: SemanticCandidate[],
  reranked: SemanticCandidate[],
  limit = 20,
): MmrEvaluation {
  const safeLimit = Math.max(0, Math.min(limit, candidates.length));
  const baseline = candidates.slice(0, safeLimit);
  const compared = reranked.slice(0, safeLimit);
  const rerankedIds = new Set(compared.map((item) => item.id));
  const overlap = baseline.filter((item) => rerankedIds.has(item.id)).length;
  const vectors = candidates.filter((item) => isUsableEmbedding(item.embedding)).length;

  return {
    topKOverlapPct: safeLimit > 0 ? (overlap / safeLimit) * 100 : 0,
    baselineDistinctAuthorRatio: distinctAuthorRatio(baseline),
    mmrDistinctAuthorRatio: distinctAuthorRatio(compared),
    baselinePairwiseSimilarity: meanPairwiseSimilarity(baseline),
    mmrPairwiseSimilarity: meanPairwiseSimilarity(compared),
    meanRelevanceDelta: meanRelevance(compared) - meanRelevance(baseline),
    semanticCoveragePct: candidates.length > 0 ? (vectors / candidates.length) * 100 : 0,
  };
}
