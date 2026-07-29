from pathlib import Path
import re


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.strip() + '\n', encoding='utf-8')


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(source.replace(old, new, 1), encoding='utf-8')


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding='utf-8-sig')
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {count}')
    target.write_text(updated, encoding='utf-8')


# Aegis fan-out supports a strict recipient subset for calls. Message delivery
# continues to use the full canonical conversation route.
replace_once(
    'src/lib/messaging/multiDeviceFanout.ts',
    "interface FanoutInput {\n  messageId: string;\n  conversationId: string;\n  senderUserId: string;\n  plaintext: string;\n}\n",
    "interface FanoutInput {\n  messageId: string;\n  conversationId: string;\n  senderUserId: string;\n  plaintext: string;\n  /** Optional exact user subset. Used for invited call participants only. */\n  recipientUserIds?: readonly string[];\n}\n",
    'fanout recipient subset contract',
)
replace_once(
    'src/lib/messaging/multiDeviceFanout.ts',
    "  const route = await resolveFanoutRouteSnapshot(input.conversationId, input.senderUserId);\n  const targets = route.targets\n    .filter(device => !isKnownInvalidDeviceId(device.deviceId));\n",
    "  const route = await resolveFanoutRouteSnapshot(input.conversationId, input.senderUserId);\n  const recipientSet = input.recipientUserIds\n    ? new Set(input.recipientUserIds.filter(Boolean))\n    : null;\n  const targets = route.targets\n    .filter(device => !isKnownInvalidDeviceId(device.deviceId))\n    .filter(device => !recipientSet || recipientSet.has(device.userId));\n",
    'fanout exact subset filter',
)

write('src/lib/calls/secureCallKeys.ts', r'''
import { safeUUID } from '@/e2ee-session';
import { supabase } from '@/integrations/supabase/client';
import { assertConversationFingerprintsTrusted } from '@/lib/crypto/fingerprintTracker';
import { base64ToBuffer } from '@/lib/crypto/utils';
import { ensureAegisDeviceReady } from '@/lib/messaging/aegisDeviceRuntime';
import {
  commitFanoutSessionTransaction,
  rollbackFanoutSessionTransaction,
} from '@/lib/messaging/fanoutSessionTransaction';
import { invalidateFanoutRoute } from '@/lib/messaging/fanoutRouteCache';
import { isAegisDeviceCopyWire } from '@/lib/messaging/messageCompatibility';
import {
  buildFanoutCopies,
  tryDecryptDeviceTargetedBody,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';

const CALL_KEY_PROTOCOL = 'forsure-aegis-call-key';
const CALL_KEY_VERSION = 1;
const CALL_KEY_BYTES = 32;
const CALL_KEY_CAPSULE_MAX_BYTES = 4 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SecureCallKeyCapsule {
  protocol: typeof CALL_KEY_PROTOCOL;
  version: typeof CALL_KEY_VERSION;
  callId: string;
  conversationId: string;
  callerUserId: string;
  callKey: string;
  createdAt: number;
}

export interface StartSecureCallInput {
  conversationId: string;
  callerUserId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
  callKeyB64: string;
  isGroup?: boolean;
}

export interface SecureCallStarted {
  callId: string;
  roomId: string;
}

type SecureCallCopyRpcRow = {
  encrypted_body: string;
  sender_user_id: string;
  sender_device_id: string;
  conversation_id: string;
  caller_id: string;
};

type SecureCallRpcResult = {
  ok?: boolean;
  code?: string;
  id?: string;
  room_id?: string;
  status?: string;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBase64Key32(value: string): boolean {
  try {
    return base64ToBuffer(value).byteLength === CALL_KEY_BYTES;
  } catch {
    return false;
  }
}

export function createSecureCallKeyCapsule(input: {
  callId: string;
  conversationId: string;
  callerUserId: string;
  callKeyB64: string;
  createdAt?: number;
}): string {
  if (!UUID_RE.test(input.callId) || !UUID_RE.test(input.conversationId)) {
    throw new Error('CALL_E2EE_INVALID_CONTEXT');
  }
  if (!UUID_RE.test(input.callerUserId) || !isBase64Key32(input.callKeyB64)) {
    throw new Error('CALL_E2EE_INVALID_KEY_CAPSULE');
  }
  return JSON.stringify({
    protocol: CALL_KEY_PROTOCOL,
    version: CALL_KEY_VERSION,
    callId: input.callId,
    conversationId: input.conversationId,
    callerUserId: input.callerUserId,
    callKey: input.callKeyB64,
    createdAt: input.createdAt ?? Date.now(),
  } satisfies SecureCallKeyCapsule);
}

export function parseSecureCallKeyCapsule(
  value: string | null | undefined,
): SecureCallKeyCapsule | null {
  if (!value || !value.startsWith('{') || utf8Length(value) > CALL_KEY_CAPSULE_MAX_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<SecureCallKeyCapsule>;
    if (
      parsed.protocol !== CALL_KEY_PROTOCOL ||
      parsed.version !== CALL_KEY_VERSION ||
      typeof parsed.callId !== 'string' || !UUID_RE.test(parsed.callId) ||
      typeof parsed.conversationId !== 'string' || !UUID_RE.test(parsed.conversationId) ||
      typeof parsed.callerUserId !== 'string' || !UUID_RE.test(parsed.callerUserId) ||
      typeof parsed.callKey !== 'string' || !isBase64Key32(parsed.callKey) ||
      typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt) || parsed.createdAt <= 0
    ) return null;
    return parsed as SecureCallKeyCapsule;
  } catch {
    return null;
  }
}

function uniqueInvitees(inviteeIds: string[], callerUserId: string): string[] {
  const unique = [...new Set(inviteeIds.filter((id) => UUID_RE.test(id) && id !== callerUserId))];
  if (unique.length === 0 || unique.length > 7) {
    throw new Error('CALL_E2EE_INVALID_INVITEE_SET');
  }
  return unique;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'CALL_E2EE_TRANSPORT_FAILED');
  }
  return String(error ?? 'CALL_E2EE_TRANSPORT_FAILED');
}

function isAmbiguousTransportFailure(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('load failed') ||
    text.includes('timeout') ||
    text.includes('connection') ||
    text.includes('aborterror')
  );
}

function isRouteStale(code: string | undefined, error: unknown): boolean {
  const text = `${code ?? ''} ${errorText(error)}`.toLowerCase();
  return text.includes('call_device_route_stale') || text.includes('e2ee_device_list_stale');
}

function rpcCopies(rows: FanoutCopyRow[]) {
  return rows.map((copy) => ({
    recipient_user_id: copy.recipient_user_id,
    recipient_device_id: copy.recipient_device_id,
    sender_device_id: copy.sender_device_id,
    encrypted_body: copy.encrypted_body,
  }));
}

async function createCallRpc(input: {
  callId: string;
  roomId: string;
  conversationId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
  senderDeviceId: string;
  copies: FanoutCopyRow[];
}): Promise<{ data: SecureCallRpcResult | null; error: unknown }> {
  const response = await (supabase as any).rpc('create_secure_call_v1', {
    p_call_id: input.callId,
    p_conversation_id: input.conversationId,
    p_room_id: input.roomId,
    p_call_type: input.callType,
    p_invitee_ids: input.inviteeIds,
    p_sender_device_id: input.senderDeviceId,
    p_key_copies: rpcCopies(input.copies),
  });
  return {
    data: (response.data ?? null) as SecureCallRpcResult | null,
    error: response.error ?? null,
  };
}

async function confirmSecureCall(callId: string): Promise<SecureCallRpcResult | null> {
  const { data, error } = await (supabase as any).rpc('get_secure_call_state_v1', {
    p_call_id: callId,
  });
  if (error) throw error;
  return (data ?? null) as SecureCallRpcResult | null;
}

async function prepareCopies(input: {
  callId: string;
  conversationId: string;
  callerUserId: string;
  inviteeIds: string[];
  callKeyB64: string;
}): Promise<FanoutCopyRow[]> {
  const plaintext = createSecureCallKeyCapsule(input);
  const built = await buildFanoutCopies({
    messageId: input.callId,
    conversationId: input.conversationId,
    senderUserId: input.callerUserId,
    plaintext,
    recipientUserIds: input.inviteeIds,
  });
  if (!built.hasTargets || built.rows.length === 0) {
    throw new Error('CALL_E2EE_DEVICE_COPIES_UNAVAILABLE');
  }
  for (const inviteeId of input.inviteeIds) {
    if (!built.rows.some((copy) => copy.recipient_user_id === inviteeId)) {
      throw new Error('CALL_E2EE_RECIPIENT_DEVICE_ROUTE_UNAVAILABLE');
    }
  }
  if (built.rows.some((copy) => !isAegisDeviceCopyWire(copy.encrypted_body))) {
    throw new Error('CALL_E2EE_DEVICE_COPY_WIRE_INVALID');
  }
  return built.rows;
}

export async function startSecureCall(
  input: StartSecureCallInput,
): Promise<SecureCallStarted> {
  if (!UUID_RE.test(input.conversationId) || !UUID_RE.test(input.callerUserId)) {
    throw new Error('CALL_E2EE_INVALID_CONTEXT');
  }
  if (!isBase64Key32(input.callKeyB64)) throw new Error('CALL_E2EE_INVALID_KEY');
  const inviteeIds = uniqueInvitees(input.inviteeIds, input.callerUserId);
  const callId = safeUUID();
  const roomId = safeUUID();
  const readyDevice = await ensureAegisDeviceReady(input.callerUserId);
  await assertConversationFingerprintsTrusted(input.callerUserId, input.conversationId);

  for (let routeAttempt = 0; routeAttempt < 2; routeAttempt += 1) {
    const copies = await prepareCopies({
      callId,
      conversationId: input.conversationId,
      callerUserId: input.callerUserId,
      inviteeIds,
      callKeyB64: input.callKeyB64,
    });

    let lastAmbiguousError: unknown = null;
    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt += 1) {
      const { data, error } = await createCallRpc({
        callId,
        roomId,
        conversationId: input.conversationId,
        inviteeIds,
        callType: input.callType,
        senderDeviceId: readyDevice.deviceId,
        copies,
      });
      if (!error && data?.ok === true) {
        commitFanoutSessionTransaction(callId);
        return { callId: data.id ?? callId, roomId: data.room_id ?? roomId };
      }

      if (isRouteStale(data?.code, error) && routeAttempt === 0) {
        await rollbackFanoutSessionTransaction(callId);
        invalidateFanoutRoute(input.conversationId, input.callerUserId);
        lastAmbiguousError = null;
        break;
      }

      const failure = error ?? new Error(data?.code ?? 'CALL_E2EE_CREATE_REJECTED');
      if (!isAmbiguousTransportFailure(failure)) {
        await rollbackFanoutSessionTransaction(callId);
        throw failure instanceof Error ? failure : new Error(errorText(failure));
      }
      lastAmbiguousError = failure;
      await new Promise((resolve) => setTimeout(resolve, 250 * (transportAttempt + 1)));
    }

    if (lastAmbiguousError) {
      try {
        const confirmed = await confirmSecureCall(callId);
        if (confirmed?.ok === true || confirmed?.id === callId) {
          commitFanoutSessionTransaction(callId);
          return { callId, roomId: confirmed.room_id ?? roomId };
        }
        await rollbackFanoutSessionTransaction(callId);
      } catch {
        // The route has advanced by one key. A later Double Ratchet message can
        // safely skip that lost key; never risk rewinding a call that committed.
      }
      throw new Error(`CALL_E2EE_CONFIRMATION_PENDING:${errorText(lastAmbiguousError)}`);
    }
  }

  throw new Error('CALL_E2EE_DEVICE_ROUTE_STALE');
}

export async function decryptSecureCallKeyForCurrentDevice(input: {
  callId: string;
  conversationId: string;
  currentUserId: string;
  expectedCallerId: string;
}): Promise<string> {
  const readyDevice = await ensureAegisDeviceReady(input.currentUserId);
  const { data, error } = await (supabase as any).rpc('get_secure_call_device_key_v1', {
    p_call_id: input.callId,
    p_device_id: readyDevice.deviceId,
  });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const row = rows[0] as SecureCallCopyRpcRow | undefined;
  if (!row || row.sender_user_id !== input.expectedCallerId) {
    throw new Error('CALL_E2EE_DEVICE_COPY_UNAVAILABLE');
  }
  if (
    row.conversation_id !== input.conversationId ||
    row.caller_id !== input.expectedCallerId ||
    !isAegisDeviceCopyWire(row.encrypted_body)
  ) {
    throw new Error('CALL_E2EE_DEVICE_COPY_CONTEXT_INVALID');
  }

  const plaintext = await tryDecryptDeviceTargetedBody(
    row,
    input.currentUserId,
    readyDevice.deviceId,
  );
  const capsule = parseSecureCallKeyCapsule(plaintext);
  if (
    !capsule ||
    capsule.callId !== input.callId ||
    capsule.conversationId !== input.conversationId ||
    capsule.callerUserId !== input.expectedCallerId
  ) {
    throw new Error('CALL_E2EE_KEY_CAPSULE_INVALID');
  }
  return capsule.callKey;
}

export const __test__ = {
  protocol: CALL_KEY_PROTOCOL,
  version: CALL_KEY_VERSION,
  keyBytes: CALL_KEY_BYTES,
  isAmbiguousTransportFailure,
};
''')

# Public Aegis call API now exposes secure per-device distribution while keeping
# the legacy 1:1 decryptor for rolling compatibility only.
replace_once(
    'src/lib/aegis/calls/index.ts',
    "export type AegisCallsModule = typeof aegisCallsModule;\nexport { encryptCallKey, decryptCallKey };\n",
    "export type AegisCallsModule = typeof aegisCallsModule;\nexport { encryptCallKey, decryptCallKey };\nexport {\n  createSecureCallKeyCapsule,\n  decryptSecureCallKeyForCurrentDevice,\n  parseSecureCallKeyCapsule,\n  startSecureCall,\n} from '@/lib/calls/secureCallKeys';\nexport type {\n  SecureCallKeyCapsule,\n  SecureCallStarted,\n  StartSecureCallInput,\n} from '@/lib/calls/secureCallKeys';\n",
    'public secure call exports',
)

# Incoming calls fetch their own device copy only at accept time. Group calls
# never treat active_calls.encrypted_call_key as plaintext again.
replace_once(
    'src/hooks/useIncomingCall.ts',
    "import { decryptCallKey, encryptCallKey } from '@/lib/aegis/calls';\n",
    "import {\n  decryptCallKey,\n  decryptSecureCallKeyForCurrentDevice,\n  startSecureCall,\n} from '@/lib/aegis/calls';\n",
    'incoming secure call imports',
)
replace_once(
    'src/hooks/useIncomingCall.ts',
    "  const encryptedCallKeyRef = useRef<string | null>(null);\n",
    "  const legacyEncryptedCallKeyRef = useRef<string | null>(null);\n",
    'incoming legacy ref declaration',
)
replace_once(
    'src/hooks/useIncomingCall.ts',
    "        // Store encrypted key in volatile ref — NEVER in React state\n        encryptedCallKeyRef.current = call.encrypted_call_key || null;\n",
    "        // Rolling compatibility: retain only a legacy 1:1 wrapped key.\n        // Group-call raw-key fallback is intentionally forbidden.\n        legacyEncryptedCallKeyRef.current = !call.is_group\n          ? call.encrypted_call_key || null\n          : null;\n",
    'incoming legacy key capture',
)
# Replace every cleanup reference after declaration.
target = Path('src/hooks/useIncomingCall.ts')
source = target.read_text(encoding='utf-8')
source = source.replace('encryptedCallKeyRef.current', 'legacyEncryptedCallKeyRef.current')
target.write_text(source, encoding='utf-8')

regex_once(
    'src/hooks/useIncomingCall.ts',
    r"    let decryptedCallKey: string \| undefined;\n    const encKey = legacyEncryptedCallKeyRef\.current;\n    const convId = callConversationIdRef\.current;\n    if \(!encKey \|\| !convId\) \{.*?\n    if \(!decryptedCallKey\) \{",
    r'''    let decryptedCallKey: string | undefined;
    const legacyEncryptedKey = legacyEncryptedCallKeyRef.current;
    const convId = callConversationIdRef.current;
    if (!convId) {
      legacyEncryptedCallKeyRef.current = null;
      callConversationIdRef.current = null;
      activeCallIdRef.current = null;
      setIncomingCall(null);
      callPhaseRef.current = 'ended';
      queueMicrotask(() => {
        callPhaseRef.current = 'idle';
      });
      throw new Error('[CALL_E2EE] Missing call context');
    }

    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) throw new Error('Not authenticated');
      decryptedCallKey = await decryptSecureCallKeyForCurrentDevice({
        callId: incomingCall.id,
        conversationId: convId,
        currentUserId: currentUser.id,
        expectedCallerId: incomingCall.caller_id,
      });
    } catch (secureDecryptError) {
      // Rolling compatibility is allowed only for old 1:1 calls whose key was
      // already encrypted. A group key is never read from active_calls.
      if (!incomingCall.is_group && legacyEncryptedKey) {
        try {
          const { data: { user: currentUser } } = await supabase.auth.getUser();
          if (!currentUser) throw new Error('Not authenticated');
          decryptedCallKey = await decryptCallKey(
            legacyEncryptedKey,
            convId,
            currentUser.id,
            incomingCall.caller_id,
          );
        } catch (legacyDecryptError) {
          console.error('[CALL] Legacy call-key decrypt failed:', legacyDecryptError);
        }
      } else {
        console.error('[CALL] Secure device call-key decrypt failed:', secureDecryptError);
      }
    }

    if (!decryptedCallKey) {''',
    'incoming accept secure device copy',
)
regex_once(
    'src/hooks/useIncomingCall.ts',
    r"export async function signalOutgoingCall\(.*?\n\}\n\n/\*\* Called when call ends",
    r'''export async function signalOutgoingCall(
  conversationId: string,
  callerId: string,
  calleeId: string,
  callType: 'audio' | 'video',
  callKeyB64?: string,
): Promise<string | null> {
  if (!callKeyB64) throw new Error('[CALL_E2EE] Missing outgoing call key');
  try {
    const started = await startSecureCall({
      conversationId,
      callerUserId: callerId,
      inviteeIds: [calleeId],
      callType,
      callKeyB64,
      isGroup: false,
    });
    return started.callId;
  } catch (error) {
    console.error('[CALL] Secure call signal failed:', error);
    return null;
  }
}

/** Called when call ends''',
    'outgoing secure call path',
)

# Group calls use the same atomic RPC and exact device copies.
write('src/lib/calls/groupCall.ts', r'''
import { supabase } from '@/integrations/supabase/client';
import { generateCallE2EEKey } from '@/hooks/useCall';
import { startSecureCall } from '@/lib/aegis/calls';

export interface StartGroupCallOptions {
  conversationId: string;
  inviteeIds: string[];
  callType: 'audio' | 'video';
}

export interface GroupCallStarted {
  callId: string;
  roomId: string;
  callKey: string;
}

export async function startGroupCall(
  opts: StartGroupCallOptions,
): Promise<GroupCallStarted> {
  const inviteeIds = [...new Set(opts.inviteeIds.filter(Boolean))];
  if (inviteeIds.length === 0) throw new Error('No invitees');
  if (inviteeIds.length > 7) throw new Error('Max 8 participants (you + 7)');

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const callKey = generateCallE2EEKey();
  const started = await startSecureCall({
    conversationId: opts.conversationId,
    callerUserId: user.id,
    inviteeIds,
    callType: opts.callType,
    callKeyB64: callKey,
    isGroup: true,
  });
  return { ...started, callKey };
}

export async function acceptGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase
    .from('active_calls')
    .select('accepted_by, status')
    .eq('id', callId)
    .single();
  if (!data) return;
  const next = Array.from(new Set([...((data.accepted_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({
    accepted_by: next,
    status: data.status === 'ringing' ? 'accepted' : data.status,
  }).eq('id', callId);
}

export async function declineGroupCall(callId: string, userId: string): Promise<void> {
  const { data } = await supabase
    .from('active_calls')
    .select('declined_by')
    .eq('id', callId)
    .single();
  if (!data) return;
  const next = Array.from(new Set([...((data.declined_by as string[] | null) ?? []), userId]));
  await supabase.from('active_calls').update({ declined_by: next }).eq('id', callId);
}
''')

write('supabase/migrations/20260729233000_secure_call_device_key_fanout.sql', r'''
begin;

create table if not exists public.call_device_key_copies (
  call_id uuid not null references public.active_calls(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_device_id text not null,
  encrypted_body text not null,
  created_at timestamptz not null default now(),
  primary key (call_id, recipient_user_id, recipient_device_id)
);

create index if not exists call_device_key_copies_recipient_idx
  on public.call_device_key_copies(recipient_user_id, recipient_device_id, call_id);

alter table public.call_device_key_copies enable row level security;
revoke all on table public.call_device_key_copies from anon, authenticated;

create or replace function public.reject_raw_group_call_key()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.is_group, false) and new.encrypted_call_key is not null then
    raise exception using
      errcode = '22023',
      message = 'GROUP_CALL_RAW_KEY_FORBIDDEN';
  end if;
  return new;
end;
$$;

drop trigger if exists active_calls_reject_raw_group_call_key on public.active_calls;
create trigger active_calls_reject_raw_group_call_key
before insert or update of encrypted_call_key, is_group on public.active_calls
for each row execute function public.reject_raw_group_call_key();

create or replace function public.create_secure_call_v1(
  p_call_id uuid,
  p_conversation_id uuid,
  p_room_id text,
  p_call_type text,
  p_invitee_ids uuid[],
  p_sender_device_id text,
  p_key_copies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_invitee_count integer;
  v_expected_count integer;
  v_copy_count integer;
  v_existing public.active_calls%rowtype;
  v_first_invitee uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_call_id is null or p_conversation_id is null
     or p_call_type not in ('audio', 'video')
     or length(trim(coalesce(p_room_id, ''))) not between 8 and 128
     or length(trim(coalesce(p_sender_device_id, ''))) < 8
     or jsonb_typeof(p_key_copies) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVALID_ARGUMENT');
  end if;

  select count(distinct invitee), min(invitee)
    into v_invitee_count, v_first_invitee
  from unnest(coalesce(p_invitee_ids, '{}'::uuid[])) invitee
  where invitee is not null and invitee <> v_uid;
  if v_invitee_count not between 1 and 7
     or v_invitee_count <> cardinality(coalesce(p_invitee_ids, '{}'::uuid[])) then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVALID_INVITEE_SET');
  end if;

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_NOT_IN_CONVERSATION');
  end if;
  if exists (
    select 1
    from unnest(p_invitee_ids) invitee
    where not exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id and cp.user_id = invitee
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVITEE_NOT_IN_CONVERSATION');
  end if;

  if not exists (
    select 1 from public.get_sesame_device_list(v_uid) sender
    where sender.device_id = trim(p_sender_device_id)
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_SENDER_DEVICE_NOT_TRUSTED');
  end if;

  select * into v_existing from public.active_calls where id = p_call_id;
  if found then
    if v_existing.caller_id = v_uid
       and v_existing.conversation_id = p_conversation_id
       and v_existing.room_id = trim(p_room_id) then
      return jsonb_build_object(
        'ok', true,
        'code', 'CALL_ALREADY_COMMITTED',
        'id', v_existing.id,
        'room_id', v_existing.room_id,
        'status', v_existing.status
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'CALL_ID_CONFLICT');
  end if;

  select count(*) into v_expected_count
  from (
    select invitee as user_id, device.device_id
    from unnest(p_invitee_ids) invitee
    cross join lateral public.get_sesame_device_list(invitee) device
  ) expected;
  if v_expected_count < v_invitee_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_RECIPIENT_DEVICE_ROUTE_UNAVAILABLE');
  end if;

  select count(*) into v_copy_count from jsonb_array_elements(p_key_copies);
  if v_copy_count <> v_expected_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_ROUTE_STALE');
  end if;
  if (
    select count(*) from (
      select distinct
        copy->>'recipient_user_id' as user_id,
        copy->>'recipient_device_id' as device_id
      from jsonb_array_elements(p_key_copies) copy
    ) unique_copies
  ) <> v_copy_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_DUPLICATE_DEVICE_COPY');
  end if;

  if exists (
    with expected as (
      select invitee::text as user_id, device.device_id
      from unnest(p_invitee_ids) invitee
      cross join lateral public.get_sesame_device_list(invitee) device
    )
    select 1
    from jsonb_array_elements(p_key_copies) copy
    left join expected
      on expected.user_id = copy->>'recipient_user_id'
     and expected.device_id = copy->>'recipient_device_id'
    where expected.device_id is null
       or copy->>'sender_device_id' <> trim(p_sender_device_id)
       or length(coalesce(copy->>'encrypted_body', '')) not between 32 and 131072
       or not (
         copy->>'encrypted_body' like 'aegis1.ratchet.%'
         or copy->>'encrypted_body' like 'aegis1.init.v1.%'
       )
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_COPY_INVALID');
  end if;

  insert into public.active_calls (
    id,
    conversation_id,
    caller_id,
    callee_id,
    caller_ids,
    is_group,
    room_id,
    call_type,
    status,
    encrypted_call_key
  ) values (
    p_call_id,
    p_conversation_id,
    v_uid,
    v_first_invitee,
    p_invitee_ids,
    v_invitee_count > 1,
    trim(p_room_id),
    p_call_type,
    'ringing',
    null
  );

  insert into public.call_device_key_copies (
    call_id,
    recipient_user_id,
    recipient_device_id,
    sender_user_id,
    sender_device_id,
    encrypted_body
  )
  select
    p_call_id,
    (copy->>'recipient_user_id')::uuid,
    copy->>'recipient_device_id',
    v_uid,
    trim(p_sender_device_id),
    copy->>'encrypted_body'
  from jsonb_array_elements(p_key_copies) copy;

  return jsonb_build_object(
    'ok', true,
    'code', 'SECURE_CALL_CREATED',
    'id', p_call_id,
    'room_id', trim(p_room_id),
    'status', 'ringing'
  );
end;
$$;

revoke all on function public.create_secure_call_v1(
  uuid, uuid, text, text, uuid[], text, jsonb
) from public, anon;
grant execute on function public.create_secure_call_v1(
  uuid, uuid, text, text, uuid[], text, jsonb
) to authenticated;

create or replace function public.get_secure_call_device_key_v1(
  p_call_id uuid,
  p_device_id text
)
returns table (
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  conversation_id uuid,
  caller_id uuid
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    copy.encrypted_body,
    copy.sender_user_id,
    copy.sender_device_id,
    call.conversation_id,
    call.caller_id
  from public.call_device_key_copies copy
  join public.active_calls call on call.id = copy.call_id
  where copy.call_id = p_call_id
    and copy.recipient_user_id = auth.uid()
    and copy.recipient_device_id = trim(p_device_id)
    and call.status in ('ringing', 'accepted', 'answered')
    and exists (
      select 1 from public.get_sesame_device_list(auth.uid()) device
      where device.device_id = trim(p_device_id)
    )
  limit 1;
$$;

revoke all on function public.get_secure_call_device_key_v1(uuid, text) from public, anon;
grant execute on function public.get_secure_call_device_key_v1(uuid, text) to authenticated;

create or replace function public.get_secure_call_state_v1(p_call_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'id', call.id,
    'room_id', call.room_id,
    'status', call.status
  )
  from public.active_calls call
  where call.id = p_call_id
    and (
      call.caller_id = auth.uid()
      or call.callee_id = auth.uid()
      or auth.uid() = any(coalesce(call.caller_ids, '{}'::uuid[]))
    )
  limit 1;
$$;

revoke all on function public.get_secure_call_state_v1(uuid) from public, anon;
grant execute on function public.get_secure_call_state_v1(uuid) to authenticated;

commit;
''')

write('src/lib/calls/__tests__/secureCallKeys.test.ts', r'''
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferToBase64 } from '@/lib/crypto/utils';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ensureReady: vi.fn(),
  assertTrusted: vi.fn(),
  buildCopies: vi.fn(),
  decryptCopy: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@/e2ee-session', () => ({
  safeUUID: vi.fn()
    .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
    .mockReturnValueOnce('22222222-2222-4222-8222-222222222222'),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));
vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({
  ensureAegisDeviceReady: mocks.ensureReady,
}));
vi.mock('@/lib/crypto/fingerprintTracker', () => ({
  assertConversationFingerprintsTrusted: mocks.assertTrusted,
}));
vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  buildFanoutCopies: mocks.buildCopies,
  tryDecryptDeviceTargetedBody: mocks.decryptCopy,
}));
vi.mock('@/lib/messaging/fanoutSessionTransaction', () => ({
  commitFanoutSessionTransaction: mocks.commit,
  rollbackFanoutSessionTransaction: mocks.rollback,
}));
vi.mock('@/lib/messaging/fanoutRouteCache', () => ({
  invalidateFanoutRoute: mocks.invalidate,
}));

import {
  createSecureCallKeyCapsule,
  parseSecureCallKeyCapsule,
  startSecureCall,
} from '@/lib/calls/secureCallKeys';

const CALLER = '33333333-3333-4333-8333-333333333333';
const INVITEE = '44444444-4444-4444-8444-444444444444';
const CONVERSATION = '55555555-5555-4555-8555-555555555555';
const KEY = bufferToBase64(new Uint8Array(32).fill(9).buffer as ArrayBuffer);
const COPY = {
  message_id: '11111111-1111-4111-8111-111111111111',
  recipient_user_id: INVITEE,
  recipient_device_id: 'recipient-device-v2',
  sender_user_id: CALLER,
  sender_device_id: 'sender-device-v2',
  encrypted_body: 'aegis1.ratchet.s7AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=.0.0.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureReady.mockResolvedValue({ deviceId: 'sender-device-v2', userId: CALLER });
  mocks.assertTrusted.mockResolvedValue(undefined);
  mocks.buildCopies.mockResolvedValue({ rows: [COPY], hasTargets: true, routeVersion: 'route-v2' });
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id: '11111111-1111-4111-8111-111111111111',
      room_id: '22222222-2222-4222-8222-222222222222',
    },
    error: null,
  });
});

describe('secure per-device call-key distribution', () => {
  it('binds a 32-byte key to the call context', () => {
    const capsule = createSecureCallKeyCapsule({
      callId: '11111111-1111-4111-8111-111111111111',
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      callKeyB64: KEY,
      createdAt: 1,
    });
    expect(parseSecureCallKeyCapsule(capsule)).toMatchObject({
      callId: '11111111-1111-4111-8111-111111111111',
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      callKey: KEY,
    });
    expect(parseSecureCallKeyCapsule(capsule.replace(CONVERSATION, 'bad'))).toBeNull();
  });

  it('sends only encrypted device copies and never the raw call key to Supabase', async () => {
    const started = await startSecureCall({
      conversationId: CONVERSATION,
      callerUserId: CALLER,
      inviteeIds: [INVITEE],
      callType: 'audio',
      callKeyB64: KEY,
    });
    expect(started.callId).toBe('11111111-1111-4111-8111-111111111111');
    expect(mocks.buildCopies).toHaveBeenCalledWith(expect.objectContaining({
      recipientUserIds: [INVITEE],
    }));
    const rpcArgs = mocks.rpc.mock.calls[0][1];
    expect(JSON.stringify(rpcArgs)).not.toContain(KEY);
    expect(rpcArgs.p_key_copies).toEqual([expect.objectContaining({
      recipient_user_id: INVITEE,
      encrypted_body: COPY.encrypted_body,
    })]);
    expect(mocks.commit).toHaveBeenCalledWith(started.callId);
  });
});
''')

write('src/lib/calls/__tests__/secureCallSourcePolicy.test.ts', r'''
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('secure call source policy', () => {
  it('never stores a raw group call key in active_calls', () => {
    const groupSource = source('../groupCall.ts');
    expect(groupSource).not.toMatch(/encrypted_call_key\s*:\s*callKey/);
    expect(groupSource).toContain('startSecureCall');
  });

  it('never treats the group database field as a decrypted key', () => {
    const incomingSource = source('../../../hooks/useIncomingCall.ts');
    expect(incomingSource).not.toMatch(/decryptedCallKey\s*=\s*(encKey|legacyEncryptedKey)/);
    expect(incomingSource).toContain('decryptSecureCallKeyForCurrentDevice');
  });

  it('ships an atomic per-device call-key migration', () => {
    const migration = source('../../../../supabase/migrations/20260729233000_secure_call_device_key_fanout.sql');
    expect(migration).toContain('create table if not exists public.call_device_key_copies');
    expect(migration).toContain('create_secure_call_v1');
    expect(migration).toContain('GROUP_CALL_RAW_KEY_FORBIDDEN');
    expect(migration).toContain('encrypted_call_key\n  ) values');
  });
});
''')

# Extend audit document with the call-key finding and remediation.
target = Path('docs/AEGIS_SIGNAL_AUDIT_V2.md')
source = target.read_text(encoding='utf-8')
source += r'''

## Secure call-key transport

The former group-call path wrote the raw LiveKit key to
`active_calls.encrypted_call_key`. This is removed. New 1:1 and group calls:

- create a fixed call UUID before signaling;
- bind the 32-byte LiveKit key to call, conversation and caller identifiers;
- fan the capsule out only to invited users' version-2 devices through the
  existing X3DH/Double Ratchet device envelopes;
- atomically insert the call and its exact device copies through a security
  definer RPC;
- fetch and decrypt one device copy only when the recipient accepts;
- reject any future group row that attempts to store a non-null database key.

A legacy wrapped-key fallback remains temporarily for old 1:1 callers during a
rolling deployment. There is no legacy group fallback.
'''
target.write_text(source, encoding='utf-8')

print('Secure per-device call-key fanout generated')
