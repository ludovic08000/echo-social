import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260927235900_close_remaining_security_gaps.sql',
  'utf8',
)
  .toLowerCase()
  .replace(/\s+/g, ' ')

const legacyProfileViewLock = readFileSync(
  'supabase/migrations/20260927235930_lock_legacy_public_profile_view.sql',
  'utf8',
)
  .toLowerCase()
  .replace(/\s+/g, ' ')

const mlFeed = readFileSync('src/hooks/useMLFeed.ts', 'utf8')
const ageFlagged = readFileSync('src/components/AgeFlaggedScreen.tsx', 'utf8')
const profile = readFileSync('src/pages/Profile.tsx', 'utf8')
const sellerDashboard = readFileSync(
  'src/components/marketplace/SellerDashboard.tsx',
  'utf8',
)

describe('final security closure', () => {
  it('binds RLS helpers to the current caller while preserving service access', () => {
    expect(migration).toContain('create or replace function public.has_role(')
    expect(migration).toContain('_user_id = auth.uid()')
    expect(migration).toContain('create or replace function public.is_conversation_participant(')
    expect(migration).toContain('uid = auth.uid()')
    expect(migration).toContain('create or replace function public.is_restricted_by(')
    expect(migration).toContain('p_viewer_id = auth.uid()')
    expect(migration).toContain("auth.jwt() ->> 'role'")
  })

  it('only exposes caller-bound ML scoring to the browser', () => {
    expect(migration).toContain(
      'create or replace function public.ml_pareto_score_batch_for_current_user(',
    )
    expect(migration).toContain(
      'from public.ml_pareto_score_batch(v_user_id, p_post_ids) as scored',
    )
    expect(migration).toContain(
      "'revoke execute on function %s from public, anon, authenticated'",
    )
    expect(mlFeed).toContain("rpc('ml_pareto_score_batch_for_current_user' as any")
    expect(mlFeed).not.toContain('p_user_id: user.id')
  })

  it('removes write privileges from public views and keeps training labels server-only', () => {
    expect(migration).toContain(
      'revoke all privileges on table public.anonymous_wall_messages_public from public, anon, authenticated',
    )
    expect(migration).toContain(
      'grant select on table public.anonymous_wall_messages_public to anon, authenticated',
    )
    expect(migration).toContain(
      'revoke all privileges on table public.ml_training_labels_v8 from public, anon, authenticated',
    )
    expect(migration).toContain(
      'grant select on table public.ml_training_labels_v8 to service_role',
    )
    expect(legacyProfileViewLock).toContain(
      'revoke all privileges on table public.public_profiles from public, anon, authenticated',
    )
    expect(legacyProfileViewLock).toContain(
      'grant select on table public.public_profiles to service_role',
    )
    expect(legacyProfileViewLock).not.toContain(
      'grant select on table public.public_profiles to anon, authenticated',
    )
  })

  it('retires the arbitrary-user contact matcher from browser roles', () => {
    expect(migration).toContain(
      'revoke execute on function public.match_contacts_by_phone(uuid, text[]) from public, anon, authenticated',
    )
    expect(migration).toContain(
      'grant execute on function public.match_contacts_by_phone(uuid, text[]) to service_role',
    )
  })

  it('revokes stale age verification state and constrains identity documents', () => {
    expect(migration).toContain("set age_verified = (p_status = 'verified')")
    expect(migration).toContain("when p_status = 'rejected' then 'rejected'")
    expect(migration).toContain("when p_status = 'deleted' then 'none'")
    expect(migration).toContain('file_size_limit = 10485760')
    expect(migration).toContain("'application/pdf'")
    expect(ageFlagged).toContain('ALLOWED_ID_DOCUMENT_TYPES.has(file.type)')
    expect(profile).toContain('ALLOWED_ID_DOCUMENT_TYPES.has(file.type)')
    expect(ageFlagged).toContain(
      'accept="image/jpeg,image/png,image/webp,application/pdf"',
    )
    expect(profile).toContain(
      'accept="image/jpeg,image/png,image/webp,application/pdf"',
    )
  })

  it('keeps marketplace video uploads inside the authenticated owner folder', () => {
    expect(sellerDashboard).toContain('PACKING_VIDEO_EXTENSIONS[file.type]')
    expect(sellerDashboard).toContain('MAX_PACKING_VIDEO_BYTES')
    expect(sellerDashboard).toContain(
      '`${seller.user_id}/packing/${orderId}/${crypto.randomUUID()}.${ext}`',
    )
    expect(sellerDashboard).not.toContain('`packing/${orderId}_${Date.now()}.${ext}`')
  })
})
