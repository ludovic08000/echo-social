import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('settings panels end-to-end wiring', () => {
  it('mounts every settings panel and the global runtime', () => {
    const app = readSource('src/App.tsx');
    const settings = readSource('src/pages/Settings.tsx');

    expect(app).toContain('<SettingsRuntime />');
    for (const tab of ['wellbeing', 'content', 'accessibility', 'privacy', 'notifications']) {
      expect(settings).toContain(`activeTab === '${tab}'`);
    }
    expect(settings).not.toContain("activeTab === 'parental'");
  });

  it('opens the local-news zone editor instead of the privacy policy', () => {
    const feedSection = readSource('src/components/feed/LocalMediaSection.tsx');
    const settings = readSource('src/pages/Settings.tsx');

    expect(feedSection).toContain('/settings?tab=privacy#discovery-heading');
    expect(feedSection).not.toContain('to="/privacy"');
    expect(settings).toContain('document.getElementById(targetId)?.scrollIntoView');
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

  it('keeps parental controls disabled on the client and at database boundaries', () => {
    const edge = readSource('supabase/functions/verify-parental-pin/index.ts');
    const hook = readSource('src/hooks/useParentalControl.ts');
    const minorHook = readSource('src/hooks/useMinorProtection.ts');
    const signup = readSource('src/pages/Signup.tsx');
    const onboarding = readSource('src/pages/Onboarding.tsx');
    const settings = readSource('src/pages/Settings.tsx');
    const migration = readSource('supabase/migrations/20261008203014_disable_parental_controls.sql');

    expect(edge).toContain('PARENTAL_CONTROLS_ENABLED = false');
    expect(edge).toContain('enabled: PARENTAL_CONTROLS_ENABLED');
    expect(edge).toContain('disabled: true');
    expect(edge).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(edge).not.toContain('.from("parental_controls")');
    expect(hook).toContain('PARENTAL_CONTROLS_ENABLED = false');
    expect(hook).not.toContain("functions.invoke('verify-parental-pin'");
    expect(minorHook).not.toContain("rpc('is_user_protected_minor'");
    expect(signup).not.toContain('Protection parentale');
    expect(signup).not.toContain('parentalPin');
    expect(onboarding).not.toContain("functions.invoke('verify-parental-pin'");
    expect(settings).not.toContain("activeTab === 'parental'");
    expect(migration).toContain('CREATE TRIGGER trg_force_parental_controls_disabled');
    expect(migration).toContain('NEW.is_active := false');
    expect(migration).toContain('NEW.is_minor := false');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.is_user_minor');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.current_viewer_parental_post_allowed');
  });

  it('never starts parental age verification from an ordinary post or profile photo', () => {
    const createPost = readSource('src/components/CreatePost.tsx');
    const profileSettings = readSource('src/components/settings/SettingsProfileTab.tsx');
    const protectedRoute = readSource('src/components/ProtectedRoute.tsx');
    const ageReview = readSource('src/components/AgeFlaggedScreen.tsx');

    expect(createPost).not.toContain('useAgeVerification');
    expect(createPost).not.toContain('verifyAge(');
    expect(profileSettings).not.toContain('useAgeVerification');
    expect(profileSettings).not.toContain('verifyAge(');
    // Explicitly flagged identity-review states remain protected; normal media never creates them.
    expect(protectedRoute).toContain("profile.age_verification_status === 'flagged'");
    expect(ageReview).not.toContain("functions.invoke('verify-parental-pin'");
    expect(ageReview).not.toContain('Définir le code parental');
    expect(ageReview).toContain("'submit_own_identity_document'");
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
