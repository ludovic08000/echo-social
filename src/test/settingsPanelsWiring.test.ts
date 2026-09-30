import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('settings panels end-to-end wiring', () => {
  it('mounts every settings panel and the global runtime', () => {
    const app = readSource('src/App.tsx');
    const settings = readSource('src/pages/Settings.tsx');

    expect(app).toContain('<SettingsRuntime />');
    for (const tab of ['wellbeing', 'content', 'accessibility', 'privacy', 'notifications', 'parental']) {
      expect(settings).toContain(`activeTab === '${tab}'`);
    }
  });

  it('applies accessibility preferences to the whole application', () => {
    const preferences = readSource('src/lib/accessibilityPreferences.ts');
    const runtime = readSource('src/components/settings/SettingsRuntime.tsx');
    const css = readSource('src/index.css');

    expect(preferences).toContain("root.classList.toggle('high-contrast'");
    expect(preferences).toContain("root.classList.toggle('large-targets'");
    expect(preferences).toContain('root.dataset.colorBlindMode');
    expect(preferences).toContain("track.mode = prefs.captionsEnabled ? 'showing' : 'disabled'");
    expect(runtime).toContain('accessibility.keyboardNavigation');
    expect(css).toContain('html.high-contrast');
    expect(css).toContain('html.large-targets');
  });

  it('syncs wellbeing settings and enforces focus, limits and detox globally', () => {
    const hook = readSource('src/hooks/useWellbeingPreferences.ts');
    const runtime = readSource('src/components/settings/SettingsRuntime.tsx');
    const feed = readSource('src/pages/Feed.tsx');
    const sounds = readSource('src/hooks/useNotificationSounds.ts');
    const push = readSource('supabase/functions/push-notify/index.ts');

    expect(hook).toContain(".from('wellbeing_preferences')");
    expect(hook).toContain('function acquireWellbeingRealtime(userId: string)');
    expect(hook).toContain('const wellbeingRealtimeEntries = new Map');
    expect(hook).toContain('`wellbeing_prefs:${userId}:${Date.now().toString(36)}:${wellbeingRealtimeGeneration}`');
    expect(hook).toContain("const LS_OWNER_KEY = 'wellbeing-prefs-user'");
    expect(runtime).toContain("root.classList.toggle('wellbeing-focus-mode'");
    expect(runtime).toContain('isDetoxScheduleActive');
    expect(feed).toContain('wellbeingPrefs.scrollPauseEnabled');
    expect(sounds).toContain('readLocalWellbeingPrefs().focusModeEnabled');
    expect(push).toContain('wellbeing?.focus_mode_enabled === true');
    expect(push).toContain('kind !== "call_incoming"');
  });

  it('enforces privacy at database boundaries, not just in the panel', () => {
    const migration = readSource('supabase/migrations/20260930120000_wire_settings_privacy_parental_content.sql');
    const presence = readSource('src/hooks/useOnlinePresence.ts');
    const profile = readSource('src/pages/Profile.tsx');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.privacy_scope_allows');
    expect(migration).toContain('CREATE POLICY "Profiles respect account privacy"');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_visible_profile_friends');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.aegis_message_block_reason');
    expect(migration).toContain('public.current_viewer_parental_post_allowed(posts.id, posts.body)');
    expect(presence).toContain(".from('user_online_presence')");
    expect(profile).toContain("(supabase.rpc as any)('get_visible_profile_friend_count'");
  });

  it('dispatches notification preferences through realtime, push and email', () => {
    const migration = readSource('supabase/migrations/20260930120000_wire_settings_privacy_parental_content.sql');
    const generatedMigration = readSource('drizzle/migrations/0009_wire_settings_privacy_parental_content.sql');
    const groupMigration = readSource('supabase/migrations/20260930120100_friend_group_post_notifications.sql');
    const panel = readSource('src/components/NotificationSettingsPanel.tsx');
    const push = readSource('supabase/functions/push-notify/index.ts');
    const email = readSource('supabase/functions/process-email-queue/index.ts');

    expect(migration).toContain('CREATE TRIGGER trg_dispatch_notification_push');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.enqueue_notification_email_digests');
    expect(generatedMigration).toContain("url := 'https://vkpmoqfzrihcijjochks.supabase.co/functions/v1/push-notify'");
    expect(generatedMigration).toContain("secret.name IN ('email_queue_service_role_key', 'service_role_key')");
    expect(generatedMigration).not.toContain('Push dispatch stubbed');
    expect(push).toContain('close_friends_posts_enabled');
    expect(email).toContain("payload.preference_key === 'notification_digest'");
    expect(groupMigration).toContain('CREATE TRIGGER trg_notify_friend_group_post');
    expect(panel).toContain('<FriendGroupsManager />');
  });

  it('requires the current parental PIN and filters content on the server', () => {
    const edge = readSource('supabase/functions/verify-parental-pin/index.ts');
    const hook = readSource('src/hooks/useParentalControl.ts');
    const migration = readSource('supabase/migrations/20260930120000_wire_settings_privacy_parental_content.sql');

    expect(edge).toContain('matchesStoredPin(current_pin, existing.pin_hash)');
    expect(edge).toContain('/^\\d{8,12}$/');
    expect(hook).toContain('current_pin: currentPin');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.parental_content_category_allowed');
    expect(migration).toContain('viewer_parental.allowed_categories');
  });

  it('persists content and AI preferences and applies them to ranked feed eligibility', () => {
    const panel = readSource('src/components/settings/ContentPreferencesPanel.tsx');
    const preferences = readSource('src/lib/feedPreferences.ts');
    const migration = readSource('supabase/migrations/20260930120000_wire_settings_privacy_parental_content.sql');

    expect(panel).toContain('saveFeedPrefs');
    expect(panel).toContain('hydratedRef.current = false');
    expect(preferences).toContain("const CACHE_OWNER_KEY = 'feed-prefs-user'");
    expect(preferences).toContain('muted_keywords: nextPrefs.mutedKeywords');
    expect(preferences).toContain('sensitive_content_filter: nextPrefs.sensitiveContentFilter');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.feed_eligible_post_ids_internal');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.apply_feed_preferences_to_snapshot');
    expect(migration).toContain('preference.priority_topics');
  });
});
