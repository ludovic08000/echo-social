import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationDirectory = 'supabase/migrations'
const hardeningMigration =
  '20260927193613_lock_stripe_and_stock_rpcs_to_service_role.sql'
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()

const normalizeSql = (value: string) =>
  value.toLowerCase().replace(/\s+/g, ' ').trim()

const hardeningSql = normalizeSql(
  readFileSync(`${migrationDirectory}/${hardeningMigration}`, 'utf8'),
)

const serverOnlyFunctions = [
  {
    name: 'stripe_mark_event_processed',
    signature: 'public.stripe_mark_event_processed(text, text)',
  },
  {
    name: 'decrement_product_stock',
    signature: 'public.decrement_product_stock(uuid, int)',
  },
]

describe('Stripe and stock database privileges', () => {
  it.each(serverOnlyFunctions)(
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

  it.each(serverOnlyFunctions)(
    'keeps the $name hardening after its last definition',
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

  it('keeps both mutations behind the signature-verified server webhook', () => {
    const webhook = readFileSync(
      'supabase/functions/stripe-webhook/index.ts',
      'utf8',
    )

    expect(webhook).toContain('stripe.webhooks.constructEvent(')
    expect(webhook).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")')
    expect(webhook).toContain('"stripe_mark_event_processed"')
    expect(webhook).toContain('"decrement_product_stock"')
  })
})
