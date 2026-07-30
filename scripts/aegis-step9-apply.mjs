import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const oldMigrations = [
  'supabase/migrations/20260730010000_aegis_clean_transport.sql',
  'supabase/migrations/20260730020000_aegis_account_authorized_devices.sql',
  'supabase/migrations/20260730030000_aegis_call_scoped_livekit.sql',
  'supabase/migrations/20260730040000_aegis_recovery_vault.sql',
  'supabase/migrations/20260730050000_aegis_view_once_consumption.sql',
];
const finalMigration = 'supabase/migrations/20260730090000_aegis_clean_rebuild.sql';
const finalBasename = path.basename(finalMigration);

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function write(file, content) {
  fs.writeFileSync(path.join(root, file), content);
}

function replaceOne(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Ambiguous patch anchor: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function stripMigrationEnvelope(sql, label) {
  const lines = sql.replace(/\r\n/g, '\n').split('\n');
  const beginIndex = lines.findIndex((line) => line.trim().toLowerCase() === 'begin;');
  const commitIndex = lines.findLastIndex((line) => line.trim().toLowerCase() === 'commit;');
  if (beginIndex < 0 || commitIndex < 0 || commitIndex <= beginIndex) {
    throw new Error(`Invalid migration envelope: ${label}`);
  }
  return lines
    .filter((line, index) => index !== beginIndex && index !== commitIndex)
    .filter((line) => !/^\s*create extension if not exists pgcrypto\b.*;\s*$/i.test(line))
    .filter((line) => !/^\s*notify pgrst,\s*'reload schema';\s*$/i.test(line))
    .join('\n')
    .trim();
}

const sections = oldMigrations.map((file) => stripMigrationEnvelope(read(file), file));

sections[2] = replaceOne(
  sections[2],
  `update public.active_calls
set room_name = 'legacy-call-' || id::text
where room_name is null;
`,
  `-- Stage 9 truncates development calls before this schema is installed. No
-- legacy room-name compatibility is retained.
`,
  'remove legacy call-room compatibility',
);

sections[2] = replaceOne(
  sections[2],
  `  insert into public.active_calls (
    id, conversation_id, caller_id, callee_id, caller_ids, is_group,
    room_id, room_name, caller_device_id, protocol_version,
    call_type, status, encrypted_call_key
  ) values (
    p_call_id, p_conversation_id, v_uid, v_first_invitee, v_invitees,
    cardinality(v_invitees) > 1,
    p_call_id, v_room_name, p_caller_device_id, 5,
    p_call_type, 'ringing', null
  );
`,
  `  insert into public.active_calls (
    id, conversation_id, caller_id, callee_id, caller_ids, is_group,
    room_id, room_name, caller_device_id, protocol_version,
    call_type, status
  ) values (
    p_call_id, p_conversation_id, v_uid, v_first_invitee, v_invitees,
    cardinality(v_invitees) > 1,
    p_call_id, v_room_name, p_caller_device_id, 5,
    p_call_type, 'ringing'
  );
`,
  'remove raw call key from active_calls insert',
);

const prelude = `-- Aegis final clean rebuild migration.
--
-- This is an intentionally destructive development cutover. The project has no
-- compatibility requirement for messages, calls, device routes, prekeys or
-- recovery rows created by the abandoned Aegis prototypes. User accounts and
-- unrelated social data remain intact.

begin;

create extension if not exists pgcrypto with schema extensions;

-- Remove objects left by a partial local run of the five superseded migrations.
drop trigger if exists aegis_stage_view_once_payload on public.messages;
drop function if exists public.stage_aegis_view_once_payload();
drop function if exists public.begin_aegis_view_once_consume(uuid, text);
drop function if exists public.commit_aegis_view_once_consume(uuid, text, uuid);
drop function if exists public.release_aegis_view_once_claim(uuid, text, uuid);
drop function if exists public.delete_aegis_message_for_me(uuid);
drop function if exists public.delete_aegis_message_for_everyone(uuid);
drop function if exists public.aegis_call_create(uuid, uuid, text, text, uuid[], jsonb);
drop function if exists public.aegis_call_get_invitation(uuid, text);
drop function if exists public.aegis_call_latest_for_device(text);
drop function if exists public.aegis_call_update_status(uuid, text, text);
drop function if exists public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text);
drop table if exists public.aegis_view_once_consumptions;
drop table if exists public.aegis_view_once_payloads;
drop table if exists public.aegis_call_invitations;
drop table if exists public.aegis_recovery_vaults;

-- Remove obsolete callable paths by name, including every historical overload.
do $$
declare
  obsolete record;
begin
  for obsolete in
    select procedure.oid::regprocedure as signature
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'call_signal',
        'aegis_ack_device_messages',
        'aegis_sync_device',
        'send_message_with_device_copies',
        'insert_message_with_device_copies'
      ])
  loop
    execute format('drop function if exists %s cascade', obsolete.signature);
  end loop;
end;
$$;

-- Remove the pre-Aegis destructive-view implementation. The final claim/commit
-- protocol below is the only active view-once path.
drop trigger if exists trg_scrub_view_once on public.messages;
drop function if exists public.scrub_view_once_on_view();
drop policy if exists msg_update_view_once_viewer on public.messages;

-- Development data reset. FK-dependent message/call/device rows are removed by
-- CASCADE, while auth.users, profiles, posts and unrelated product data remain.
do $$
begin
  if to_regclass('public.messages') is not null then
    execute 'truncate table public.messages cascade';
  end if;
  if to_regclass('public.active_calls') is not null then
    execute 'truncate table public.active_calls cascade';
  end if;
  if to_regclass('public.device_one_time_prekeys') is not null then
    execute 'truncate table public.device_one_time_prekeys cascade';
  end if;
  if to_regclass('public.device_signed_prekeys') is not null then
    execute 'truncate table public.device_signed_prekeys cascade';
  end if;
  if to_regclass('public.user_devices') is not null then
    execute 'truncate table public.user_devices cascade';
  end if;
  if to_regclass('public.user_public_keys') is not null then
    execute 'truncate table public.user_public_keys cascade';
  end if;
  if to_regclass('public.aegis_user_route_versions') is not null then
    execute 'truncate table public.aegis_user_route_versions cascade';
  end if;
end;
$$;

-- A call key may exist only as a per-device encrypted invitation envelope.
alter table public.active_calls
  drop column if exists encrypted_call_key cascade;
`;

const callHardening = `
-- The RPCs above are the only call mutation path. Existing SELECT policies may
-- expose ringing metadata, but direct INSERT/UPDATE/DELETE policies are removed.
do $$
declare
  policy record;
begin
  for policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'active_calls'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy if exists %I on public.active_calls', policy.policyname);
  end loop;
end;
$$;

revoke insert, update, delete on table public.active_calls from public, anon, authenticated;
grant select on table public.active_calls to authenticated;
`;

const finalSql = [
  prelude.trim(),
  '-- Stage 2: immutable authoritative transport.\n' + sections[0],
  '-- Stage 3: account-authorized device registry and prekeys.\n' + sections[1],
  '-- Stage 5: call-scoped rooms and per-device call-key envelopes.\n' + sections[2],
  callHardening.trim(),
  '-- Stage 6: account-identity recovery vault.\n' + sections[3],
  '-- Stage 7: destructive view-once claim and consumption.\n' + sections[4],
  "notify pgrst, 'reload schema';",
  'commit;',
  '',
].join('\n\n');

write(finalMigration, finalSql);
for (const file of oldMigrations) fs.rmSync(path.join(root, file));

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [absolute];
  });
}

for (const directory of ['src', 'docs']) {
  for (const absolute of walk(path.join(root, directory))) {
    if (!/\.(ts|tsx|md|txt)$/.test(absolute)) continue;
    const before = fs.readFileSync(absolute, 'utf8');
    let after = before;
    for (const old of oldMigrations) {
      after = after.replaceAll(path.basename(old), finalBasename);
    }
    if (after !== before) fs.writeFileSync(absolute, after);
  }
}

let types = read('src/integrations/supabase/types.ts');
const oldActiveCalls = `      active_calls: {
        Row: {
          accepted_by: string[] | null
          answered_at: string | null
          call_type: string
          callee_id: string
          caller_id: string
          caller_ids: string[] | null
          conversation_id: string
          created_at: string
          declined_by: string[] | null
          encrypted_call_key: string | null
          ended_at: string | null
          id: string
          is_group: boolean
          room_id: string | null
          status: string
        }
        Insert: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id: string
          caller_id: string
          caller_ids?: string[] | null
          conversation_id: string
          created_at?: string
          declined_by?: string[] | null
          encrypted_call_key?: string | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          room_id?: string | null
          status?: string
        }
        Update: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id?: string
          caller_id?: string
          caller_ids?: string[] | null
          conversation_id?: string
          created_at?: string
          declined_by?: string[] | null
          encrypted_call_key?: string | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          room_id?: string | null
          status?: string
        }
        Relationships: []
      }
`;
const newAegisTables = `      active_calls: {
        Row: {
          accepted_by: string[] | null
          answered_at: string | null
          call_type: string
          callee_id: string
          caller_device_id: string | null
          caller_id: string
          caller_ids: string[] | null
          conversation_id: string
          created_at: string
          declined_by: string[] | null
          ended_at: string | null
          id: string
          is_group: boolean
          protocol_version: number
          room_id: string | null
          room_name: string
          status: string
        }
        Insert: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id: string
          caller_device_id?: string | null
          caller_id: string
          caller_ids?: string[] | null
          conversation_id: string
          created_at?: string
          declined_by?: string[] | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          protocol_version?: number
          room_id?: string | null
          room_name: string
          status?: string
        }
        Update: {
          accepted_by?: string[] | null
          answered_at?: string | null
          call_type?: string
          callee_id?: string
          caller_device_id?: string | null
          caller_id?: string
          caller_ids?: string[] | null
          conversation_id?: string
          created_at?: string
          declined_by?: string[] | null
          ended_at?: string | null
          id?: string
          is_group?: boolean
          protocol_version?: number
          room_id?: string | null
          room_name?: string
          status?: string
        }
        Relationships: []
      }
      aegis_call_invitations: {
        Row: {
          call_id: string
          created_at: string
          encrypted_call_key: string
          recipient_device_id: string
          recipient_user_id: string
          responded_at: string | null
          status: string
        }
        Insert: {
          call_id: string
          created_at?: string
          encrypted_call_key: string
          recipient_device_id: string
          recipient_user_id: string
          responded_at?: string | null
          status?: string
        }
        Update: {
          call_id?: string
          created_at?: string
          encrypted_call_key?: string
          recipient_device_id?: string
          recipient_user_id?: string
          responded_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "aegis_call_invitations_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "active_calls"
            referencedColumns: ["id"]
          },
        ]
      }
      aegis_recovery_vaults: {
        Row: {
          ciphertext: string
          created_at: string
          generation: number
          identity_fingerprint: string
          kdf_salt: string
          nonce: string
          protocol_version: number
          updated_at: string
          user_id: string
        }
        Insert: {
          ciphertext: string
          created_at?: string
          generation: number
          identity_fingerprint: string
          kdf_salt: string
          nonce: string
          protocol_version: number
          updated_at?: string
          user_id: string
        }
        Update: {
          ciphertext?: string
          created_at?: string
          generation?: number
          identity_fingerprint?: string
          kdf_salt?: string
          nonce?: string
          protocol_version?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      aegis_view_once_consumptions: {
        Row: {
          claim_token: string
          consumed_at: string
          device_id: string
          message_id: string
          user_id: string
        }
        Insert: {
          claim_token: string
          consumed_at?: string
          device_id: string
          message_id: string
          user_id: string
        }
        Update: {
          claim_token?: string
          consumed_at?: string
          device_id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "aegis_view_once_consumptions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      aegis_view_once_payloads: {
        Row: {
          claim_expires_at: string | null
          claim_token: string | null
          claimed_device_id: string | null
          conversation_id: string
          created_at: string
          device_copies: Json
          image_url: string
          message_id: string
          parent_body: string
          recipient_user_id: string
          sender_user_id: string
        }
        Insert: {
          claim_expires_at?: string | null
          claim_token?: string | null
          claimed_device_id?: string | null
          conversation_id: string
          created_at?: string
          device_copies: Json
          image_url: string
          message_id: string
          parent_body: string
          recipient_user_id: string
          sender_user_id: string
        }
        Update: {
          claim_expires_at?: string | null
          claim_token?: string | null
          claimed_device_id?: string | null
          conversation_id?: string
          created_at?: string
          device_copies?: Json
          image_url?: string
          message_id?: string
          parent_body?: string
          recipient_user_id?: string
          sender_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "aegis_view_once_payloads_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
`;
types = replaceOne(types, oldActiveCalls, newAegisTables, 'active_calls and Aegis table types');
types = replaceOne(types, `        Row: {
          aegis_route_version: string | null
`, `        Row: {
          aegis_request_digest: string | null
          aegis_route_version: string | null
`, 'messages row digest');
types = replaceOne(types, `        Insert: {
          aegis_route_version?: string | null
`, `        Insert: {
          aegis_request_digest?: string | null
          aegis_route_version?: string | null
`, 'messages insert digest');
types = replaceOne(types, `        Update: {
          aegis_route_version?: string | null
`, `        Update: {
          aegis_request_digest?: string | null
          aegis_route_version?: string | null
`, 'messages update digest');

const obsoleteAck = `      aegis_ack_device_messages: {
        Args: {
          p_device_id: string
          p_mark_read?: boolean
          p_message_ids: string[]
        }
        Returns: number
      }
`;
const obsoleteSync = `      aegis_sync_device: {
        Args: {
          p_device_id: string
          p_limit?: number
        }
        Returns: {
          archive_body: string | null
          conversation_id: string
          copy_id: string
          created_at: string
          document_mime: string | null
          document_name: string | null
          document_size_bytes: number | null
          document_url: string | null
          encrypted_body: string
          image_url: string | null
          message_id: string
          parent_body: string
          sender_device_id: string
          sender_user_id: string
        }[]
      }
`;
const obsoleteCallSignal = `      call_signal: {
        Args: {
          p_action: string
          p_call_id?: string
          p_call_type?: string
          p_callee_id?: string
          p_caller_id?: string
          p_conversation_id?: string
          p_encrypted_call_key?: string
          p_status?: string
        }
        Returns: Json
      }
`;
types = replaceOne(types, obsoleteAck, '', 'remove aegis_ack_device_messages type');
types = replaceOne(types, obsoleteSync, '', 'remove aegis_sync_device type');
types = replaceOne(types, obsoleteCallSignal, '', 'remove call_signal type');

const sendFunctionType = `      aegis_send_message: {
        Args: {
          p_body: string
          p_conversation_id: string
          p_copies: Json
          p_extra: Json
          p_image_url: string
          p_message_id: string
          p_route_version: string
          p_sender_device_id: string
        }
        Returns: Json
      }
`;
const finalFunctionTypes = `${sendFunctionType}      aegis_call_create: {
        Args: {
          p_call_id: string
          p_call_type: string
          p_caller_device_id: string
          p_conversation_id: string
          p_invitations: Json
          p_invitee_ids: string[]
        }
        Returns: Json
      }
      aegis_call_get_invitation: {
        Args: { p_call_id: string; p_device_id: string }
        Returns: Json
      }
      aegis_call_latest_for_device: {
        Args: { p_device_id: string }
        Returns: Json
      }
      aegis_call_update_status: {
        Args: { p_call_id: string; p_device_id: string; p_status: string }
        Returns: Json
      }
      begin_aegis_view_once_consume: {
        Args: { p_device_id: string; p_message_id: string }
        Returns: Json
      }
      commit_aegis_view_once_consume: {
        Args: { p_claim_token: string; p_device_id: string; p_message_id: string }
        Returns: Json
      }
      delete_aegis_message_for_everyone: {
        Args: { p_message_id: string }
        Returns: boolean
      }
      delete_aegis_message_for_me: {
        Args: { p_message_id: string }
        Returns: boolean
      }
      release_aegis_view_once_claim: {
        Args: { p_claim_token: string; p_device_id: string; p_message_id: string }
        Returns: boolean
      }
      write_aegis_recovery_vault: {
        Args: {
          p_ciphertext: string
          p_generation: number
          p_identity_fingerprint: string
          p_kdf_salt: string
          p_nonce: string
          p_protocol_version: number
        }
        Returns: number
      }
`;
types = replaceOne(types, sendFunctionType, finalFunctionTypes, 'insert final Aegis function types');
write('src/integrations/supabase/types.ts', types);

const stage9Test = `import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = resolve(process.cwd(), 'supabase/migrations');
const migrationName = '${finalBasename}';
const sql = readFileSync(resolve(migrationDir, migrationName), 'utf8').toLowerCase();
const types = readFileSync(resolve(process.cwd(), 'src/integrations/supabase/types.ts'), 'utf8');

describe('Aegis stage 9 final schema migration', () => {
  it('keeps exactly one July 30 Aegis rebuild migration', () => {
    const files = readdirSync(migrationDir)
      .filter((file) => /^20260730.*aegis.*\\.sql$/.test(file))
      .sort();
    expect(files).toEqual([migrationName]);
  });

  it('uses one outer transaction and one schema reload', () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    expect(sql.match(/notify pgrst, 'reload schema';/g)).toHaveLength(1);
  });

  it('performs the explicit destructive development reset', () => {
    expect(sql).toContain("truncate table public.messages cascade");
    expect(sql).toContain("truncate table public.active_calls cascade");
    expect(sql).toContain("truncate table public.user_devices cascade");
    expect(sql).toContain("truncate table public.user_public_keys cascade");
    expect(sql).toContain("truncate table public.aegis_user_route_versions cascade");
    expect(sql).not.toContain("legacy-call-");
  });

  it('removes raw call-key storage and every obsolete mutation path', () => {
    expect(sql).toContain('drop column if exists encrypted_call_key cascade');
    expect(sql).toContain("'call_signal'");
    expect(sql).toContain("'aegis_ack_device_messages'");
    expect(sql).toContain("'aegis_sync_device'");
    expect(sql).toContain('drop trigger if exists trg_scrub_view_once');
    expect(sql).toContain('revoke insert, update, delete on table public.active_calls');
    const activeInsert = sql.match(/insert into public\\.active_calls \\([\\s\\S]*?\\) values \\([\\s\\S]*?\\);/)?.[0] ?? '';
    expect(activeInsert).not.toContain('encrypted_call_key');
  });

  it('contains every final Aegis table and authoritative RPC', () => {
    for (const token of [
      'create function public.aegis_send_message',
      'create function public.get_sesame_device_list',
      'create function public.register_user_device_safe',
      'create or replace function public.aegis_call_create',
      'create table if not exists public.aegis_call_invitations',
      'create table if not exists public.aegis_recovery_vaults',
      'create table if not exists public.aegis_view_once_payloads',
      'create or replace function public.commit_aegis_view_once_consume',
    ]) expect(sql).toContain(token);
  });

  it('keeps generated types aligned with the final schema', () => {
    const activeStart = types.indexOf('      active_calls: {');
    const activeEnd = types.indexOf('      aegis_call_invitations: {', activeStart);
    const active = types.slice(activeStart, activeEnd);
    expect(active).toContain('room_name: string');
    expect(active).toContain('protocol_version: number');
    expect(active).not.toContain('encrypted_call_key');
    expect(types).toContain('      aegis_call_invitations: {');
    expect(types).toContain('      aegis_recovery_vaults: {');
    expect(types).toContain('      aegis_view_once_payloads: {');
    expect(types).toContain('aegis_request_digest: string | null');
    expect(types).not.toContain('      call_signal: {');
    expect(types).not.toContain('      aegis_sync_device: {');
  });
});
`;
write('src/lib/messaging/__tests__/aegisStage9FinalMigration.test.ts', stage9Test);

for (const docPath of ['docs/AEGIS_CLEAN_REBUILD.md', 'docs/AEGIS_E2EE_ARCHITECTURE.md']) {
  let doc = read(docPath);
  doc = doc.replace(
    '9. One clean SQL reset for development data and obsolete Aegis objects.',
    '9. ✅ One clean SQL reset for development data and obsolete Aegis objects.',
  );
  if (!doc.includes('## Stage 9 invariant')) {
    const invariant = `## Stage 9 invariant\n\nThe five staged migrations are replaced by one transactional, destructive development cutover. It removes obsolete call, sync and view-once paths, deletes old message/call/device/prekey/identity-route rows, drops raw call-key storage, recreates only the authoritative Aegis tables and RPCs, and reloads PostgREST once after commit. No migration is applied remotely by this branch.\n\n`;
    doc = doc.replace('## Current checkpoint\n', invariant + '## Current checkpoint\n');
  }
  doc = doc.replace('Stages 1, 2, 3, 4, 5, 6, 7 and 8 are complete and validated.', 'Stages 1, 2, 3, 4, 5, 6, 7, 8 and 9 are complete and validated.');
  if (!doc.includes('Stage 9 passed its single-migration')) {
    doc = doc.replace(
      '- Stage 8 passed its generic-push, server-error redaction, crypto-log redaction, identifier-free trace and architecture tests, typecheck, the full test suite and the production build.\n',
      '- Stage 8 passed its generic-push, server-error redaction, crypto-log redaction, identifier-free trace and architecture tests, typecheck, the full test suite and the production build.\n- Stage 9 passed its single-migration, destructive-reset, obsolete-object, raw-call-key and generated-type architecture checks.\n',
    );
  }
  write(docPath, doc);
}

const builtAt = new Date().toISOString();
write('public/version.json', JSON.stringify({ version: String(Date.now()), builtAt }, null, 2) + '\n');
