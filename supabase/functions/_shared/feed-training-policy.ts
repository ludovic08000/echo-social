// Pure policy helpers shared by offline jobs and their regression tests.
export const SIGNAL_LABEL: Readonly<Record<string, number>> = Object.freeze({
  view: 0.1, dwell_medium: 0.4, dwell_long: 0.7, watch_complete: 0.9,
  like: 0.8, comment: 0.9, share: 1, save: 0.9, click: 0.5,
  hide: -0.8, not_interested: -0.9, report: -1, skip_fast: -0.4,
});

export function trainingSnippet(body: string | null): string {
  // Minimize public opt-in text, not user profiles or private messages.
  // Pattern removal is not a guarantee of complete anonymisation.
  return (body ?? '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, '[number]')
    .replace(/@[\p{L}\p{N}_]+/gu, '[mention]')
    .replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function clickThroughRate(events: Array<{ user_id: string; post_id: string; signal_type: string }>): number {
  const views = new Set(events.filter(e => e.signal_type === 'view').map(e => e.user_id + ':' + e.post_id));
  const clicks = new Set(events.filter(e => e.signal_type === 'click').map(e => e.user_id + ':' + e.post_id));
  return views.size ? [...clicks].filter(key => views.has(key)).length / views.size : 0;
}

export function normalizeAffinities(values: Record<string, number>): Record<string, number> {
  const scale = Math.max(0.0001, ...Object.values(values).map(Math.abs));
  return Object.fromEntries(Object.entries(values).map(([key,value]) => [key, Number((value / scale).toFixed(3))]));
}
