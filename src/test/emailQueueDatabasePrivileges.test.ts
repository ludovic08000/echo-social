import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDirectory = 'supabase/migrations'
const hardeningMigration =
  '20260927193206_lock_email_queue_rpcs_to_service_role.sql'
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const normalizeSql = (value: string) =>
  value.toLowerCase().replace(/\s+/g, ' ').trim()

const hardeningSql = normalizeSql(
  readFileSync(`${migrationDirectory}/${hardeningMigration}`, 'utf8'),
)

const queueFunctions = [
  {
    name: 'enqueue_email',
    signature: 'public.enqueue_email(text, jsonb)',
  },
  {
    name: 'read_email_batch',
    signature: 'public.read_email_batch(text, int, int)',
  },
  {
    name: 'delete_email',
    signature: 'public.delete_email(text, bigint)',
  },
  {
    name: 'move_to_dlq',
    signature: 'public.move_to_dlq(text, text, bigint, jsonb)',
  },
]

describe('email queue database privileges', () => {
  it.each(queueFunctions)(
    'allows only service_role to execute $name',
    ({ signature }) => {
      expect(hardeningSql).toContain(
        `revoke execute on function ${signature} from public, anon, authenticated;`,
      )
      expect(hardeningSql).toContain(
        `grant execute on function ${signature} to service_role;`,
      )
    },
  )

  it.each(queueFunctions)(
    'keeps the $name hardening after its last function definition',
    ({ name }) => {
      const hardeningIndex = migrationFiles.indexOf(hardeningMigration)
      const definitionIndexes = migrationFiles.flatMap((file, index) => {
        const sql = normalizeSql(
          readFileSync(`${migrationDirectory}/${file}`, 'utf8'),
        )
        return sql.includes(`create or replace function public.${name}(`)
          ? [index]
          : []
      })

      expect(definitionIndexes.length).toBeGreaterThan(0)
      expect(hardeningIndex).toBeGreaterThan(Math.max(...definitionIndexes))
    },
  )

  it('keeps every queue caller on a server-side Supabase client', () => {
    const dispatcher = readFileSync(
      'supabase/functions/process-email-queue/index.ts',
      'utf8',
    )
    const transactionalEmail = readFileSync(
      'supabase/functions/send-transactional-email/index.ts',
      'utf8',
    )
    const securityMonitor = readFileSync(
      'supabase/functions/security-monitor/index.ts',
      'utf8',
    )

    expect(dispatcher).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')")
    expect(transactionalEmail).toContain(
      "Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')",
    )
    expect(securityMonitor).toContain(
      'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")',
    )
  })
})
