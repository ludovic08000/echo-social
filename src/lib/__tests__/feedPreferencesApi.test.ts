import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/lib/feedApi', () => ({ readFeedPreferences: mocks.read, writeFeedPreferences: mocks.write }));
import { saveFeedPrefs, syncFeedPrefsFromServer } from '../feedPreferences';
const row = { feed_algorithm: 'chronological', ai_summaries_enabled: false, auto_translate_enabled: true,
  diversity_boost: 25, muted_keywords: ['spam'], priority_topics: ['education'], viral_content_reduce: true,
  sensitive_content_filter: true, seen_posts_hide: true, weight_friends: 70, weight_discovery: 20,
  weight_news: 80, weight_marketplace: 5 };
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.read.mockResolvedValue(row); mocks.write.mockImplementation(async (_user, prefs) => prefs); });

it('preserves this user server preferences when another account left a local cache', async () => {
  localStorage.setItem('feed-prefs-user', 'other');
  localStorage.setItem('content-prefs', JSON.stringify({ feedAlgorithm: 'smart', mutedKeywords: ['other'] }));
  await saveFeedPrefs('alice', { diversityBoost: 40 });
  expect(mocks.write).toHaveBeenCalledWith('alice', { ...row, diversity_boost: 40 });
  expect(JSON.parse(localStorage.getItem('content-prefs')!)).toMatchObject({ feedAlgorithm: 'chronological', mutedKeywords: ['spam'] });
  expect(localStorage.getItem('feed-prefs-user')).toBe('alice');
});
it('does not overwrite settings with defaults when the server read fails', async () => {
  mocks.read.mockRejectedValue(new Error('offline'));
  await expect(saveFeedPrefs('alice', { diversityBoost: 40 })).rejects.toThrow('offline');
  expect(mocks.write).not.toHaveBeenCalled();
});
it('uses an insert-only migration and caches the canonical row in case another tab already saved', async () => {
  mocks.read.mockResolvedValue(null); mocks.write.mockResolvedValue(row);
  await syncFeedPrefsFromServer('alice');
  expect(mocks.write.mock.calls[0][2]).toBe(true);
  expect(JSON.parse(localStorage.getItem('content-prefs')!)).toMatchObject({ feedAlgorithm: 'chronological', priorityTopics: ['education'] });
});
it('does not pretend a failed settings update succeeded in local storage', async () => {
  mocks.write.mockRejectedValue(new Error('denied'));
  await expect(saveFeedPrefs('alice', { diversityBoost: 40 })).rejects.toThrow('denied');
  expect(localStorage.getItem('content-prefs')).toBeNull();
});
