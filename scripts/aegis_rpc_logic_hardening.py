from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new)


# Scope every conversation invalidation to the authenticated user.
messages_path = Path("src/hooks/useMessages.ts")
messages = messages_path.read_text()
messages = replace_once(
    messages,
    "let keysRestoredConversationRefetchTimer: ReturnType<typeof setTimeout> | null = null;\n\nfunction scheduleKeysRestoredConversationRefetch",
    """let keysRestoredConversationRefetchTimer: ReturnType<typeof setTimeout> | null = null;

function invalidateUserConversations(queryClient: QueryClient, userId: string): void {
  void queryClient.invalidateQueries({
    queryKey: ['conversations', userId],
    exact: true,
  });
}

function scheduleKeysRestoredConversationRefetch""",
    "conversation invalidation helper",
)

for hook_name in (
    "useAcceptMessageRequest",
    "useRejectMessageRequest",
    "useAddGroupMembers",
    "useRemoveGroupMember",
):
    marker = f"export function {hook_name}() {{\n  const queryClient = useQueryClient();"
    replacement = (
        f"export function {hook_name}() {{\n"
        "  const queryClient = useQueryClient();\n"
        "  const { user } = useAuth();"
    )
    messages = replace_once(messages, marker, replacement, f"auth context for {hook_name}")

legacy = "queryClient.invalidateQueries({ queryKey: ['conversations'] });"
legacy_count = messages.count(legacy)
if legacy_count < 1:
    raise SystemExit("expected at least one global conversation invalidation")
messages = messages.replace(
    legacy,
    "if (user?.id) invalidateUserConversations(queryClient, user.id);",
)
messages_path.write_text(messages)


# Re-mark an open conversation read whenever a new incoming server message arrives.
widget_path = Path("src/components/ChatWidget.tsx")
widget = widget_path.read_text()
widget = replace_once(
    widget,
    """  useEffect(() => {
    if (conversationId) markConversationRead(conversationId);
  }, [conversationId, markConversationRead]);""",
    """  const latestIncomingMessageId = messages?.reduce<string | undefined>(
    (latest, message) => message.sender_id !== user?.id ? message.id : latest,
    undefined,
  );

  useEffect(() => {
    if (conversationId) markConversationRead(conversationId);
  }, [conversationId, latestIncomingMessageId, markConversationRead]);""",
    "open conversation read tracking",
)
widget_path.write_text(widget)


# Isolate in-flight inbox work by authenticated account and DeviceID.
inbox_path = Path("src/lib/messaging/aegisDeviceInbox.ts")
inbox = inbox_path.read_text()
inbox = replace_once(
    inbox,
    "let syncInflight: Promise<AegisInboxRow[]> | null = null;",
    "const syncInflight = new Map<string, Promise<AegisInboxRow[]>>();",
    "inbox in-flight state",
)
start = inbox.index("export async function syncAegisDeviceInbox")
end = inbox.index("/**\n * The final schema has no server acknowledgement RPC.", start)
new_sync = """export async function syncAegisDeviceInbox(userId: string): Promise<AegisInboxRow[]> {
  const ready = await ensureAegisDeviceReady(userId);
  if (ready.userId !== userId) {
    throw new Error('AEGIS_DEVICE_USER_MISMATCH');
  }

  const syncKey = `${userId}:${ready.deviceId}`;
  const active = syncInflight.get(syncKey);
  if (active) return active;

  const operation = (async () => {
    const { data: references, error: referenceError } = await supabase
      .from('messages')
      .select('id')
      .eq('body_kind', 'multi_device')
      .order('created_at', { ascending: false })
      .limit(100);
    if (referenceError) throw referenceError;

    const messageIds = Array.from(new Set(
      (references ?? [])
        .map((row) => row.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ));
    if (messageIds.length === 0) return [];

    const { data, error } = await supabase.rpc('get_device_copies_for_messages', {
      p_message_ids: messageIds,
      p_device_id: ready.deviceId,
    });
    if (error) throw error;

    const rows = (data ?? []) as AegisInboxRow[];
    for (const row of rows) dispatchInboxRow(row, ready.deviceId);
    return rows;
  })();

  syncInflight.set(syncKey, operation);
  try {
    return await operation;
  } finally {
    if (syncInflight.get(syncKey) === operation) syncInflight.delete(syncKey);
  }
}

"""
inbox_path.write_text(inbox[:start] + new_sync + inbox[end:])


# Harden the deployed RPC contract without changing its public signature.
migration_path = Path("supabase/migrations/20260801142000_harden_device_copy_lookup.sql")
migration_path.write_text("""begin;

create or replace function public.get_device_copies_for_messages(
  p_message_ids uuid[],
  p_device_id text
)
returns table (
  message_id uuid,
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  recipient_device_id text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    copy.message_id,
    copy.encrypted_body,
    copy.sender_user_id,
    copy.sender_device_id,
    copy.recipient_device_id,
    copy.created_at
  from public.message_device_copies copy
  join public.messages message
    on message.id = copy.message_id
   and message.sender_id = copy.sender_user_id
  join public.conversation_participants participant
    on participant.conversation_id = message.conversation_id
   and participant.user_id = auth.uid()
  where auth.uid() is not null
    and coalesce(cardinality(p_message_ids), 0) between 1 and 200
    and nullif(trim(coalesce(p_device_id, '')), '') is not null
    and copy.message_id = any(p_message_ids)
    and copy.recipient_user_id = auth.uid()
    and copy.recipient_device_id = trim(p_device_id)
    and exists (
      select 1
      from public.user_devices device
      where device.user_id = auth.uid()
        and device.device_id = trim(p_device_id)
        and device.is_active = true
        and coalesce(device.approval_status, 'approved') = 'approved'
        and device.revoked_at is null
        and coalesce(device.routing_status, 'repairing') <> 'unavailable'
        and nullif(trim(device.device_public_key), '') is not null
        and nullif(trim(device.device_signing_key), '') is not null
        and nullif(trim(device.device_authorization_signature), '') is not null
    )
  order by copy.created_at, copy.message_id;
$$;

revoke all on function public.get_device_copies_for_messages(uuid[],text) from public, anon;
grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated;

notify pgrst, 'reload schema';

commit;
""")


# Strengthen architecture tests.
compatibility_path = Path("src/lib/messaging/__tests__/aegisUiRpcCompatibility.test.ts")
compatibility = compatibility_path.read_text()
compatibility_insert = """

  it('scopes every conversation invalidation to the authenticated user', () => {
    const source = read('src/hooks/useMessages.ts');
    expect(source).toContain('invalidateUserConversations');
    expect(source).not.toContain("queryClient.invalidateQueries({ queryKey: ['conversations'] });");
  });

  it('marks an open conversation read again when a new incoming message arrives', () => {
    const source = read('src/components/ChatWidget.tsx');
    expect(source).toContain('const latestIncomingMessageId = messages?.reduce<string | undefined>');
    expect(source).toContain('[conversationId, latestIncomingMessageId, markConversationRead]');
  });

  it('hardens the device-copy RPC around membership, active device and bounded input', () => {
    const migration = read('supabase/migrations/20260801142000_harden_device_copy_lookup.sql');
    expect(migration).toContain('join public.conversation_participants participant');
    expect(migration).toContain("coalesce(cardinality(p_message_ids), 0) between 1 and 200");
    expect(migration).toContain("coalesce(device.approval_status, 'approved') = 'approved'");
    expect(migration).toContain('device.revoked_at is null');
    expect(migration).toContain("grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated");
  });
"""
close = compatibility.rfind("\n});")
if close < 0:
    raise SystemExit("unable to extend compatibility tests")
compatibility_path.write_text(compatibility[:close] + compatibility_insert + compatibility[close:])

inbox_test_path = Path("src/lib/messaging/__tests__/aegisDeviceInbox.test.ts")
inbox_test = inbox_test_path.read_text()
inbox_insert = """

  it('does not share an in-flight synchronization across users or devices', async () => {
    mocks.ensureReady.mockImplementation(async (userId: string) => ({
      deviceId: `device-${userId}`,
      expiresAt: Date.now() + 30_000,
      userId,
    }));
    mocks.limit.mockResolvedValue({
      data: [{ id: 'message-scoped' }],
      error: null,
    });
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    await Promise.all([
      syncAegisDeviceInbox('user-one'),
      syncAegisDeviceInbox('user-two'),
    ]);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('get_device_copies_for_messages', {
      p_message_ids: ['message-scoped'],
      p_device_id: 'device-user-one',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('get_device_copies_for_messages', {
      p_message_ids: ['message-scoped'],
      p_device_id: 'device-user-two',
    });
  });

  it('rejects a device runtime resolved for another user', async () => {
    mocks.ensureReady.mockResolvedValue({
      deviceId: 'device-other',
      expiresAt: Date.now() + 30_000,
      userId: 'user-other',
    });

    await expect(syncAegisDeviceInbox('user-one'))
      .rejects.toThrow('AEGIS_DEVICE_USER_MISMATCH');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
"""
close = inbox_test.rfind("\n});")
if close < 0:
    raise SystemExit("unable to extend inbox tests")
inbox_test_path.write_text(inbox_test[:close] + inbox_insert + inbox_test[close:])
