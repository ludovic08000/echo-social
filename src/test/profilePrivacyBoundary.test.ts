import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  'supabase/migrations/20260927234500_protect_profile_and_identity_state.sql',
  'utf8',
)
  .toLowerCase()
  .replace(/\s+/g, ' ')

const profileHook = readFileSync('src/hooks/useProfile.ts', 'utf8')
const authConfirm = readFileSync('src/pages/AuthConfirm.tsx', 'utf8')
const ageFlagged = readFileSync('src/components/AgeFlaggedScreen.tsx', 'utf8')
const profilePage = readFileSync('src/pages/Profile.tsx', 'utf8')
const creatorHook = readFileSync('src/hooks/useCreator.ts', 'utf8')

describe('profile and identity security boundary', () => {
  it('masks viewer-controlled profile fields on the server', () => {
    expect(migration).toContain('create or replace function public.get_profile_for_viewer(p_user_id uuid)')
    expect(migration).toContain("coalesce(v_visibility ->> 'date_of_birth', 'public') = 'friends'")
    expect(migration).toContain("coalesce(v_visibility ->> 'city', 'public') = 'friends'")
    expect(migration).toContain("'age_verification_status', case when v_is_owner or v_is_admin")
    expect(migration).toContain("'onboarding_completed', case when v_is_owner or v_is_admin")
  })

  it('removes direct Data API access to private and server-owned profile columns', () => {
    expect(migration).toContain(
      'revoke all privileges on table public.profiles from public, anon, authenticated;',
    )
    expect(migration).toContain('grant select ( id, user_id, name, avatar_url, bio')
    expect(migration).not.toMatch(/grant select \([^;]*(date_of_birth|phone_number|age_verified|onboarding_completed)/)
    expect(migration).toContain(
      'revoke all privileges on table public.profiles_public from public, anon, authenticated;',
    )
  })

  it('routes profile reads and writes through narrow RPCs', () => {
    expect(profileHook).toContain("'get_profile_for_viewer'")
    expect(profileHook).toContain("'update_own_profile'")
    expect(profileHook).not.toContain(".from('profiles')")
    expect(authConfirm).toContain("supabase.rpc('get_onboarding_state'")
    expect(creatorHook).toContain("'deactivate_own_creator_profile'")
    expect(creatorHook).not.toContain(".from('profiles').update")
  })

  it('stores identity documents privately and makes the server own status changes', () => {
    expect(ageFlagged).toContain(".from('id-documents')")
    expect(ageFlagged).toContain("'submit_own_identity_document'")
    expect(ageFlagged).not.toContain('uploadToR2')
    expect(profilePage).toContain("'submit_own_identity_document'")
    expect(migration).toContain(
      'revoke all privileges on table public.identity_verifications from public, anon, authenticated;',
    )
    expect(migration).toContain(
      'grant select on table public.identity_verifications to authenticated;',
    )
    expect(migration).toContain(
      'grant insert (reported_user_id, reporter_id, reason) on public.identity_verifications to authenticated;',
    )
  })
})
