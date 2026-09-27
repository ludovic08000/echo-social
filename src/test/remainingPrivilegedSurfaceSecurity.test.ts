import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationPath =
  'supabase/migrations/20260927221752_harden_remaining_privileged_surfaces.sql'

const sql = readFileSync(migrationPath, 'utf8')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()

const serverOnlyFunctions = [
  'public.is_user_minor(uuid)',
  'public.ml_build_post_embedding_text(uuid)',
  'public.ml_build_user_embedding_text(uuid)',
  'public.threat_shield_active_model()',
  'public.email_queue_dispatch()',
  'public.cleanup_ai_cache()',
  'public.cleanup_old_behavior_signals()',
  'public.cleanup_old_fingerprints()',
  'public.cleanup_old_login_attempts()',
  'public.ddos_cleanup()',
  'public.purge_old_ai_engine_events()',
  'public.purge_old_audit_logs()',
  'public.purge_old_crypto_error_logs()',
  'public.purge_old_feed_score_tamper_events()',
  'public.purge_old_threat_decisions()',
  'public.check_login_rate_limit(text, text)',
  'public.record_login_attempt(text, text, boolean, text)',
  'public.ddos_check_ip(text, text, integer, integer)',
  'public.ml_compute_post_scores(uuid)',
  'public.ml_refresh_creator_features_v8(uuid)',
  'public.ml_embeddings_cron_tick()',
]

describe('remaining privileged database surfaces', () => {
  it.each(serverOnlyFunctions)(
    'makes %s executable by service_role only',
    (signature) => {
      expect(sql).toContain(
        `revoke execute on function ${signature} from public, anon, authenticated;`,
      )
      expect(sql).toContain(
        `grant execute on function ${signature} to service_role;`,
      )
    },
  )

  it('binds onboarding mutations and reads to the authenticated account', () => {
    expect(sql).toContain('_user_id is distinct from auth.uid()')
    expect(sql).toContain('p.user_id = _user_id and ( _user_id = auth.uid()')
    expect(sql).toContain(
      'revoke execute on function public.advance_onboarding_step(uuid, smallint) from public, anon;',
    )
    expect(sql).toContain(
      'revoke execute on function public.complete_onboarding(uuid) from public, anon;',
    )
  })

  it('prevents cross-account privacy and PIN-state lookups', () => {
    expect(sql).toContain('p_user_id = auth.uid()')
    expect(sql).toContain("public.has_role(auth.uid(), 'admin'::public.app_role)")
    expect(sql).toContain(
      'revoke execute on function public.has_chat_pin(uuid) from public, anon;',
    )
  })

  it('keeps threat telemetry behind an administrator check', () => {
    expect(sql).toContain(
      'create or replace function public.threat_shield_stats(window_minutes integer default 60)',
    )
    expect(sql).toContain(
      'create or replace function public.threat_shield_ml_stats()',
    )
    expect(sql.match(/public\.has_role\(auth\.uid\(\), 'admin'::public\.app_role\)/g))
      .toHaveLength(4)
  })

  it('requires user-owned folders for legacy product and post media', () => {
    expect(sql).toContain(
      'drop policy if exists "users can update their product images" on storage.objects;',
    )
    expect(sql).toContain(
      'drop policy if exists "users can delete their product images" on storage.objects;',
    )
    expect(sql).toContain(
      'create policy "owners can upload their product images" on storage.objects for insert to authenticated',
    )
    expect(sql).toContain(
      'create policy "users can upload their own post images" on storage.objects for insert to authenticated',
    )
    expect(sql.match(/auth\.uid\(\)::text = \(storage\.foldername\(name\)\)\[1\]/g)?.length)
      .toBeGreaterThanOrEqual(5)
  })
})
