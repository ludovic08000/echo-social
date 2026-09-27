import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260927230615_harden_authenticated_rpc_and_edge_data.sql',
  'utf8',
)
  .toLowerCase()
  .replace(/\s+/g, ' ')

const imageOptimize = readFileSync(
  'supabase/functions/image-optimize/index.ts',
  'utf8',
)

const dataCleanup = readFileSync(
  'supabase/functions/data-cleanup/index.ts',
  'utf8',
)

describe('residual privileged-surface hardening', () => {
  it('binds friend suggestions to the caller and removes anonymous execution', () => {
    expect(migration).toContain('target_user_id is distinct from auth.uid()')
    expect(migration).toContain("raise exception 'forbidden'")
    expect(migration).toContain(
      'revoke execute on function public.get_friend_suggestions(uuid, integer) from public, anon;',
    )
    expect(migration).toContain("coalesce(p.field_visibility ->> 'city', 'public') = 'public'")
  })

  it('authenticates and bounds watch-time aggregation', () => {
    expect(migration).toContain('create or replace function public.ml_record_watch_time(')
    expect(migration).toContain('if auth.uid() is null')
    expect(migration).toContain('p_sample_count > 500')
    expect(migration).toContain('p_sample_count::numeric * 86400000::numeric')
    expect(migration).toContain(
      'revoke execute on function public.ml_record_watch_time(uuid, numeric, integer) from public, anon;',
    )
  })

  it('keeps internal scores, vectors, model config, and AI writes non-public', () => {
    expect(migration).toContain(
      'revoke execute on function public.get_public_trust_score(uuid) from public, anon, authenticated;',
    )
    expect(migration).toContain(
      'create policy "service role can insert ai_metrics_log" on public.ai_metrics_log for insert to service_role',
    )
    expect(migration).toContain(
      'create policy "admins manage config" on public.ml_model_config for all to authenticated',
    )
    expect(migration).toContain(
      'create policy "service role manages post embeddings" on public.ml_post_embeddings for all to service_role',
    )
    expect(migration).toContain(
      'create policy "creator features admin manage" on public.ml_creator_features for all to authenticated',
    )
    expect(migration).toContain(
      'create policy "admins manage models" on public.ml_models for all to authenticated',
    )
  })

  it('requires authenticated owner folders for remaining Storage writes', () => {
    expect(migration).toContain(
      'create policy "users can update their own avatar" on storage.objects for update to authenticated',
    )
    expect(migration).toContain(
      'create policy "users can update their own backgrounds" on storage.objects for update to authenticated',
    )
    expect(migration).toContain(
      'create policy "users can update their videos" on storage.objects for update to authenticated',
    )
    expect(migration.match(/with check \( bucket_id = '(avatars|backgrounds|videos)'/g))
      .toHaveLength(6)
  })

  it('bounds the public image proxy to trusted hosts and payloads', () => {
    expect(imageOptimize).toContain('MAX_IMAGE_BYTES')
    expect(imageOptimize).toContain('redirect: "error"')
    expect(imageOptimize).toContain('readBodyWithLimit')
    expect(imageOptimize).toContain('ALLOWED_IMAGE_TYPES.has(contentType)')
    expect(imageOptimize).toContain('"image/jpeg"')
    expect(imageOptimize).toContain(
      'parsedUrl.pathname.startsWith("/storage/v1/object/public/")',
    )
    expect(imageOptimize).toContain(
      'const isTrusted = isPublicSupabaseObject || isPublicR2Object',
    )
    expect(imageOptimize).not.toContain('JSON.stringify({ error: String(err) })')
    expect(imageOptimize).not.toContain('host.endsWith(".r2.dev")')
    expect(imageOptimize).not.toContain('host.endsWith(".r2.cloudflarestorage.com")')
  })

  it('protects destructive cleanup with cron or administrator authorization', () => {
    expect(dataCleanup).toContain('requireCronSecret')
    expect(dataCleanup).toContain('requireAdmin')
    expect(dataCleanup).toContain('req.method !== "POST"')
  })
})
