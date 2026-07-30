import fs from 'node:fs';

function replaceOne(source, needle, replacement, label) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(needle, index + needle.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

const messagesPath = 'src/hooks/useMessages.ts';
let messages = fs.readFileSync(messagesPath, 'utf8');
messages = replaceOne(messages,
`          const newMsg = payload.new as MessageRow;
          if (isUnsupportedEncryptedBody(newMsg.body)) {
`,
`          const newMsg = payload.new as MessageRow;
          const isViewOnce = newMsg.view_once === true;
          if (isUnsupportedEncryptedBody(newMsg.body)) {
`,
'realtime view-once classification');
messages = replaceOne(messages,
`          const enriched: Message = {
            ...newMsg,
            status: newMsg.status as Message['status'],
`,
`          const enriched: Message = {
            ...newMsg,
            body: isViewOnce ? '🔒 Vue unique' : newMsg.body,
            body_kind: isViewOnce ? 'view_once' : newMsg.body_kind,
            image_url: isViewOnce ? null : newMsg.image_url,
            archive_body: isViewOnce ? null : newMsg.archive_body,
            view_once_state: isViewOnce
              ? (newMsg.sender_id === user.id ? 'sent' : 'pending')
              : undefined,
            status: newMsg.status as Message['status'],
`,
'realtime view-once redaction');
messages = replaceOne(messages,
`          if (user && isMultiDeviceMessageRow(newMsg)) {
`,
`          if (user && !isViewOnce && isMultiDeviceMessageRow(newMsg)) {
`,
'realtime decrypt exclusion');
messages = replaceOne(messages,
`      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
`,
`      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'aegis_view_once_consumptions',
          filter: \`user_id=eq.${'${user.id}'}\`,
        },
        (payload) => {
          const messageId = (payload.new as { message_id?: string }).message_id;
          if (!messageId) return;
          const key = messagesKey(conversationId, user.id);
          const existing = queryClient.getQueryData<Message[]>(key)?.find((message) => message.id === messageId);
          queryClient.setQueryData<Message[]>(key, (old) => old?.map((message) =>
            message.id === messageId
              ? { ...message, view_once_state: 'consumed', body: '🔒 Vue unique', image_url: null }
              : message
          ) || []);
          if (existing) {
            void purgeMessageLocalState({
              messageId,
              body: existing.body,
              imageUrl: existing.image_url,
            });
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
`,
'view-once consumption realtime');
messages = replaceOne(messages,
`          if (deletedId) {
            queryClient.setQueryData<Message[]>(
              messagesKey(conversationId, user?.id),
              (old) => old?.filter(m => m.id !== deletedId) || []
            );
          }
`,
`          if (deletedId) {
            const key = messagesKey(conversationId, user?.id);
            const existing = queryClient.getQueryData<Message[]>(key)?.find((message) => message.id === deletedId);
            queryClient.setQueryData<Message[]>(
              key,
              (old) => old?.filter(m => m.id !== deletedId) || []
            );
            if (existing) {
              void purgeMessageLocalState({
                messageId: deletedId,
                body: existing.body,
                imageUrl: existing.image_url,
              });
            }
          }
`,
'remote deletion cleanup');
fs.writeFileSync(messagesPath, messages);

const migrationPath = 'supabase/migrations/20260730050000_aegis_view_once_consumption.sql';
let migration = fs.readFileSync(migrationPath, 'utf8');
migration = replaceOne(migration,
`notify pgrst, 'reload schema';
commit;
`,
`do $$
begin
  alter publication supabase_realtime add table public.aegis_view_once_consumptions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

notify pgrst, 'reload schema';
commit;
`,
'view-once realtime publication');
fs.writeFileSync(migrationPath, migration);

console.log('Aegis stage 7 realtime hardening applied');
