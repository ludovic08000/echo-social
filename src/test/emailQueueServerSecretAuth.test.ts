import { describe, expect, it } from 'vitest'
import {
  configuredServerSecretKeys,
  isAuthorizedServerRequest,
  presentedServerSecret,
} from '../../supabase/functions/process-email-queue/server-secret-auth'

const modernSecret = 'sb_secret_dispatcher_123456'
const legacyServiceRole = 'legacy.service.role.jwt'

describe('email queue server-secret authentication', () => {
  it('accepts a configured modern secret on the apikey header', () => {
    const headers = new Headers({ apikey: modernSecret })

    expect(isAuthorizedServerRequest(headers, [modernSecret])).toBe(true)
  })

  it('accepts the current cron Bearer transport for a configured opaque secret', () => {
    const headers = new Headers({ Authorization: `Bearer ${modernSecret}` })

    expect(isAuthorizedServerRequest(headers, [modernSecret])).toBe(true)
  })

  it('keeps the configured legacy service-role key working during migration', () => {
    const keys = configuredServerSecretKeys(
      JSON.stringify({ default: modernSecret }),
      legacyServiceRole
    )
    const headers = new Headers({ Authorization: `Bearer ${legacyServiceRole}` })

    expect(keys).toEqual([modernSecret, legacyServiceRole])
    expect(isAuthorizedServerRequest(headers, keys)).toBe(true)
  })

  it('rejects an unconfigured token even if its text resembles a service role', () => {
    const headers = new Headers({
      Authorization: 'Bearer forged.service_role.jwt',
    })

    expect(isAuthorizedServerRequest(headers, [modernSecret])).toBe(false)
  })

  it('rejects conflicting apikey and Authorization credentials', () => {
    const headers = new Headers({
      apikey: modernSecret,
      Authorization: `Bearer ${legacyServiceRole}`,
    })

    expect(presentedServerSecret(headers)).toBeNull()
    expect(
      isAuthorizedServerRequest(headers, [modernSecret, legacyServiceRole])
    ).toBe(false)
  })

  it('falls back safely when the modern secret dictionary is malformed', () => {
    expect(configuredServerSecretKeys('{invalid', legacyServiceRole)).toEqual([
      legacyServiceRole,
    ])
  })

  it('rejects requests when no configured server credential is available', () => {
    const headers = new Headers({ Authorization: `Bearer ${modernSecret}` })

    expect(isAuthorizedServerRequest(headers, [])).toBe(false)
  })
})
