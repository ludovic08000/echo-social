import fs from 'node:fs';

function edit(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change applied to ${path}`);
  fs.writeFileSync(path, after);
}

function replaceOne(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

edit('src/lib/crypto/plaintextStore.ts', (source) => replaceOne(source,
`export async function wipePlaintextStore(): Promise<void> {`,
`export async function removePlaintextForCiphertext(ciphertextBody: string): Promise<void> {
  if (!ciphertextBody) return;
  try {
    const id = await toCiphertextLookupKey(ciphertextBody);
    volatileMirror.delete(id);
    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).delete(id);
    });
  } catch (error) {
    warnOnce('[plaintextStore] remove ciphertext lookup skipped safely', error);
  }
}

export async function wipePlaintextStore(): Promise<void> {`,
'plaintext ciphertext deletion'));

edit('src/components/messages/decryptedMediaCache.ts', (source) => replaceOne(source,
`export function clearDecryptedMediaCache(): void {
`,
`export function forgetDecryptedMediaByUrl(encryptedUrl: string): void {
  if (!encryptedUrl) return;
  const prefix = \`${'${encryptedUrl}'}\\x00\`;
  for (const [cacheKey, entry] of Array.from(store.entries())) {
    if (!cacheKey.startsWith(prefix)) continue;
    store.delete(cacheKey);
    cloneInflight.delete(cacheKey);
    retireEntry(entry);
  }
}

export function clearDecryptedMediaCache(): void {
`,
'decrypted media URL purge'));

edit('src/components/messages/decryptionService.ts', (source) => {
  source = replaceOne(source,
`const inflight = new Map<string, Promise<DecryptionOutcome | null>>();
`,
`const inflight = new Map<string, Promise<DecryptionOutcome | null>>();
const purgedMessageIds = new Set<string>();
const PURGED_MESSAGE_CAP = 2_000;
`,
'decryption purge tombstones');
  source = replaceOne(source,
`  if (!messageId || body === undefined || outcome.hidden || outcome.text === '') return;
`,
`  if (!messageId || purgedMessageIds.has(messageId) || body === undefined || outcome.hidden || outcome.text === '') return;
`,
'last-good purge guard');
  source = replaceOne(source,
`export function dropCache(messageId: string | undefined, body: string): void {
  cache.delete(cacheKey(messageId, body));
}
`,
`export function dropCache(messageId: string | undefined, body: string): void {
  cache.delete(cacheKey(messageId, body));
}

export function purgeDecryptionStateForMessage(messageId: string, body?: string): void {
  if (!messageId) return;
  purgedMessageIds.add(messageId);
  while (purgedMessageIds.size > PURGED_MESSAGE_CAP) {
    const oldest = purgedMessageIds.values().next().value as string | undefined;
    if (!oldest) break;
    purgedMessageIds.delete(oldest);
  }
  if (body !== undefined) {
    const key = cacheKey(messageId, body);
    cache.delete(key);
    inflight.delete(key);
  }
  clearLastGoodOutcome(messageId);
  clearNegativeCacheForMessage(messageId);
  senderCache.delete(messageId);
}
`,
'decryption purge API');
  source = replaceOne(source,
`  rememberLastGoodOutcome(messageId, outcome, body);
  if (messageId) void savePlaintext(messageId, persisted);
  void savePlaintextForCiphertext(body, persisted);
`,
`  if (messageId && purgedMessageIds.has(messageId)) return persisted;
  rememberLastGoodOutcome(messageId, outcome, body);
  if (messageId) void savePlaintext(messageId, persisted);
  void savePlaintextForCiphertext(body, persisted);
`,
'persist purge guard');
  source = replaceOne(source,
`): Promise<DecryptionOutcome> {
  cache.set(key, outcome);
`,
`): Promise<DecryptionOutcome> {
  if (messageId && purgedMessageIds.has(messageId)) return Promise.resolve(outcome);
  cache.set(key, outcome);
`,
'cache purge guard');
  source = replaceOne(source,
`  const { body, messageId, decrypt } = opts;
  const traceStartedAt = Date.now();
`,
`  const { body, messageId, decrypt } = opts;
  if (messageId && purgedMessageIds.has(messageId)) {
    return { text: '', mediaKeyB64: null, hidden: true };
  }
  const traceStartedAt = Date.now();
`,
'resolve purge guard');
  return source;
});

edit('src/lib/messaging/aegisOutboundEngine.ts', (source) => {
  source = replaceOne(source,
`import { traceE2EE } from '@/lib/messaging/e2eeTrace';
`,
`import { traceE2EE } from '@/lib/messaging/e2eeTrace';
import { purgeMessageLocalState } from '@/lib/messaging/messageLocalCleanup';
`,
'outbound cleanup import');
  source = replaceOne(source,
`  const archiveBackupEnabled =
    resumed?.archiveBackupEnabled ?? isArchiveBackupEnabled();
`,
`  const isViewOnce = Boolean(input.extra?.view_once ?? resumed?.extra?.view_once);
  const archiveBackupEnabled = !isViewOnce && (
    resumed?.archiveBackupEnabled ?? isArchiveBackupEnabled()
  );
`,
'view-once archive policy');
  source = replaceOne(source,
`  await Promise.all([
    persist(),
    savePlaintext(messageId, input.plaintext),
  ]);
`,
`  await Promise.all([
    persist(),
    isViewOnce ? Promise.resolve() : savePlaintext(messageId, input.plaintext),
  ]);
`,
'view-once plaintext durability');
  source = replaceOne(source,
`      await savePlaintext(\`aegis-capsule:${'${messageId}'}\`, keyCapsule);
`,
`      if (!isViewOnce) await savePlaintext(\`aegis-capsule:${'${messageId}'}\`, keyCapsule);
`,
'view-once capsule cache');
  source = replaceOne(source,
`        archive_body: archiveBody,
`,
`        archive_body: isViewOnce ? null : archiveBody,
`,
'view-once archive request');
  source = replaceOne(source,
`  void savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  if (archiveBackupEnabled) {
`,
`  if (!isViewOnce) {
    void savePlaintextForCiphertext(parentBody, input.plaintext).catch(() => undefined);
  }
  if (archiveBackupEnabled) {
`,
'view-once post-commit cache');
  source = replaceOne(source,
`  await deleteOutboxPayload(localId).catch(() => undefined);
  trace('SEND_COMPLETE', { copyCount: copies.length });
`,
`  await deleteOutboxPayload(localId).catch(() => undefined);
  if (isViewOnce) {
    await purgeMessageLocalState({
      messageId: committedId,
      body: parentBody,
      imageUrl: input.imageUrl ?? resumed?.imageUrl ?? null,
    });
  }
  trace('SEND_COMPLETE', { copyCount: copies.length });
`,
'view-once sender purge');
  return source;
});

edit('src/hooks/useAegisMessageQueue.ts', (source) => {
  source = replaceOne(source,
`  body: string;
  image_url: string | null;
`,
`  body: string;
  body_kind?: string | null;
  view_once?: boolean;
  image_url: string | null;
`,
'sent snapshot view-once fields');
  source = replaceOne(source,
`    const sentMessage: SentMessageSnapshot = {
      id: data.id,
      conversation_id: conversationId,
      sender_id: user.id,
      body: bodyToStore,
      image_url: imageUrl || null,
`,
`    const isViewOnce = Boolean(extra?.view_once);
    const sentMessage: SentMessageSnapshot = {
      id: data.id,
      conversation_id: conversationId,
      sender_id: user.id,
      body: isViewOnce ? '🔒 Vue unique' : bodyToStore,
      body_kind: isViewOnce ? 'view_once' : (encryptedSuccessfully ? 'multi_device' : 'system'),
      view_once: isViewOnce,
      image_url: isViewOnce ? null : imageUrl || null,
`,
'sent snapshot redaction');
  return source;
});

edit('src/hooks/useMessages.ts', (source) => {
  source = replaceOne(source,
`import type { Database } from '@/integrations/supabase/types';
`,
`import type { Database } from '@/integrations/supabase/types';
import { purgeMessageLocalState } from '@/lib/messaging/messageLocalCleanup';
`,
'message cleanup import');
  source = replaceOne(source,
`  archive_body?: string | null;
  aegis_route_version?: string | null;
`,
`  archive_body?: string | null;
  aegis_route_version?: string | null;
  view_once?: boolean;
  view_once_state?: 'pending' | 'consumed' | 'sent';
`,
'Message view-once fields');
  source = replaceOne(source,
`          .slice(-24)
          .filter(isMultiDeviceMessageRow);
`,
`          .slice(-24)
          .filter((message) => !message.view_once && isMultiDeviceMessageRow(message));
`,
'skip automatic view-once decrypt');
  source = replaceOne(source,
`      const senderIds = [...new Set(compatibleMessages.map(m => m.sender_id))];
`,
`      const viewOnceIds = compatibleMessages
        .filter((message) => message.view_once === true && message.sender_id !== user.id)
        .map((message) => message.id);
      const consumedViewOnceIds = new Set<string>();
      if (viewOnceIds.length > 0) {
        const { data: consumedRows } = await supabase
          .from('aegis_view_once_consumptions' as never)
          .select('message_id')
          .eq('user_id', user.id)
          .in('message_id', viewOnceIds);
        for (const row of (consumedRows ?? []) as unknown as Array<{ message_id: string }>) {
          consumedViewOnceIds.add(row.message_id);
        }
      }

      const senderIds = [...new Set(compatibleMessages.map(m => m.sender_id))];
`,
'view-once consumption lookup');
  source = replaceOne(source,
`      return compatibleMessages.map(msg => ({
        ...msg,
        profile: {
`,
`      return compatibleMessages.map(msg => ({
        ...msg,
        view_once_state: msg.view_once === true
          ? (msg.sender_id === user.id
              ? 'sent'
              : consumedViewOnceIds.has(msg.id) ? 'consumed' : 'pending')
          : undefined,
        profile: {
`,
'view-once query mapping');
  const mutateAnchor = `      queryClient.setQueryData<Message[]>(
        key,
        (old) => old?.filter(m => m.id !== messageId) || []
      );

      return { previousMessages, conversationId };
`;
  const mutateReplacement = `      const removedMessage = previousMessages?.find((message) => message.id === messageId);
      queryClient.setQueryData<Message[]>(
        key,
        (old) => old?.filter(m => m.id !== messageId) || []
      );
      if (removedMessage) {
        void purgeMessageLocalState({
          messageId,
          body: removedMessage.body,
          imageUrl: removedMessage.image_url,
        });
      }

      return { previousMessages, conversationId };
`;
  const count = source.split(mutateAnchor).length - 1;
  if (count !== 2) throw new Error(`Expected two deletion mutate anchors, found ${'${count}'}`);
  source = source.split(mutateAnchor).join(mutateReplacement);
  source = replaceOne(source,
`      const { error } = await supabase
        .from('message_deletions')
        .insert({ message_id: messageId, user_id: user.id });

      // Déjà supprimé côté utilisateur -> considérer comme succès idempotent
      if (error && error.code !== '23505') throw error;
`,
`      const { data, error } = await supabase.rpc('delete_aegis_message_for_me' as never, {
        p_message_id: messageId,
      } as never);
      if (error || data !== true) throw error ?? new Error('MESSAGE_DELETE_FOR_ME_UNCONFIRMED');
`,
'delete for me RPC');
  source = replaceOne(source,
`      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
        .eq('sender_id', user.id);

      if (error) throw error;
`,
`      const { data, error } = await supabase.rpc('delete_aegis_message_for_everyone' as never, {
        p_message_id: messageId,
      } as never);
      if (error || data !== true) throw error ?? new Error('MESSAGE_DELETE_FOR_EVERYONE_UNCONFIRMED');
`,
'delete for everyone RPC');
  return source;
});

edit('src/components/ChatWidget.tsx', (source) => {
  source = replaceOne(source,
`import { DisappearingMessagesDialog } from '@/components/messages/DisappearingMessagesDialog';
`,
`import { DisappearingMessagesDialog } from '@/components/messages/DisappearingMessagesDialog';
import { ViewOnceMessage } from '@/components/messages/ViewOnceMessage';
`,
'view-once component import');
  source = replaceOne(source,
`    if (isDoc) {
      if (file.size > 100 * 1024 * 1024) {
`,
`    if (isDoc) {
      if (armedVO) {
        toast.error('La vue unique est réservée aux photos et vidéos.');
        return;
      }
      if (file.size > 100 * 1024 * 1024) {
`,
'view-once document rejection');
  source = replaceOne(source,
`                   const isNegotiationMsg = msg.body.startsWith('💰 OFFRE:') || msg.body.startsWith('✅ OFFRE') || msg.body.startsWith('❌ OFFRE') || msg.body.startsWith('🔄 CONTRE') || msg.body.startsWith('✅ CONTRE');

                  return (
`,
`                   const isNegotiationMsg = msg.body.startsWith('💰 OFFRE:') || msg.body.startsWith('✅ OFFRE') || msg.body.startsWith('❌ OFFRE') || msg.body.startsWith('🔄 CONTRE') || msg.body.startsWith('✅ CONTRE');

                  if (msg.view_once) {
                    return (
                      <div
                        key={msg.id}
                        className={cn('flex gap-1.5 relative group', isFirstInGroup ? 'mt-2' : 'mt-0.5')}
                      >
                        <div className="w-6 flex-shrink-0">
                          {isLastInGroup && <UserAvatar src={msg.profile.avatar_url} alt={msg.profile.name} size="xs" />}
                        </div>
                        <div className="max-w-[80%] flex flex-col items-start">
                          <ViewOnceMessage
                            messageId={msg.id}
                            isMe={isMe}
                            state={msg.view_once_state}
                          />
                          <div className="flex items-center gap-1 mt-0.5 px-0.5">
                            <span className="text-[8px] text-muted-foreground">{format(new Date(msg.created_at), 'HH:mm')}</span>
                            {isMe && <CheckCheck className="w-2.5 h-2.5 text-primary/60" />}
                            <button
                              type="button"
                              onClick={() => deleteForMe.mutate({ messageId: msg.id, conversationId })}
                              className="text-[8px] text-muted-foreground hover:text-destructive"
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
`,
'view-once early rendering');
  return source;
});

console.log('Aegis stage 7 patch applied');
