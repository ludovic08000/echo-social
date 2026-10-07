export interface NewsComment {
  id: string; user_id: string | null; body: string; parent_id: string | null; created_at: string; removed: boolean;
}
export interface NewsDiscussion {
  id: string; canonical_url: string; source_name: string; locked: boolean;
  article: { title: string; excerpt: string; published_at: string } | null;
  comments: NewsComment[];
}
export const isNewsId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function newsError(error: unknown): string {
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (code.includes('COMMENT_RATE_LIMITED')) return 'Attends trois secondes avant de commenter à nouveau.';
  if (code.includes('REPORT_RATE_LIMITED')) return 'Limite de signalements atteinte. Réessaie plus tard.';
  if (code.includes('REPLY_UNAVAILABLE')) return 'Cette réponse n’est plus possible. Actualise la discussion.';
  if (code.includes('DISCUSSION_UNAVAILABLE')) return 'Cette discussion est fermée ou indisponible pour ton compte.';
  return 'Action non confirmée. Réessaie : ton texte est conservé.';
}
// Admin report links are strict first-party URLs, never arbitrary evidence/script URLs.
export function newsReportTarget(url: string): { thread: string; comment: string } | null {
  const match = /^https:\/\/forsure\.fans\/news\/([0-9a-f-]{36})#comment-([0-9a-f-]{36})$/i.exec(url);
  return match && isNewsId(match[1]) && isNewsId(match[2]) ? { thread: match[1], comment: match[2] } : null;
}
