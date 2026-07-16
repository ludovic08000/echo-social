import type { Plugin } from 'vite';

function replaceRequired(
  source: string,
  anchor: string,
  replacement: string,
  label: string,
): string {
  if (!source.includes(anchor)) {
    throw new Error(`[forsure-guard] required anchor missing: ${label}`);
  }
  return source.replace(anchor, replacement);
}

function transformChatView(code: string): string {
  let transformed = code;

  transformed = replaceRequired(
    transformed,
    "import { LRUMap } from '@/lib/utils/lruMap';",
    "import { CiphertextBoundPlaintextCache } from '@/lib/messaging/ciphertextBoundPlaintextCache';",
    'ChatView plaintext cache import',
  );
  transformed = replaceRequired(
    transformed,
    'const decryptedCache = new LRUMap<string, string>(2000);',
    'const decryptedCache = new CiphertextBoundPlaintextCache(2000);',
    'ChatView plaintext cache instance',
  );

  const cacheRenderAnchor = `  const [cacheVersion, setCacheVersion] = useState(0);
  const bumpCache = useCallback(() => setCacheVersion(v => v + 1), []);`;
  const cacheRenderCoalesced = `  const [cacheVersion, setCacheVersion] = useState(0);
  const cacheRenderFrameRef = useRef<number | null>(null);
  const bumpCache = useCallback(() => {
    if (cacheRenderFrameRef.current !== null) return;
    cacheRenderFrameRef.current = window.requestAnimationFrame(() => {
      cacheRenderFrameRef.current = null;
      setCacheVersion((version) => version + 1);
    });
  }, []);
  useEffect(() => () => {
    if (cacheRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(cacheRenderFrameRef.current);
      cacheRenderFrameRef.current = null;
    }
  }, []);`;
  transformed = replaceRequired(
    transformed,
    cacheRenderAnchor,
    cacheRenderCoalesced,
    'ChatView coalesced cache render',
  );

  transformed = replaceRequired(
    transformed,
    `  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);`,
    `  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);`,
    'ChatView near-bottom ref',
  );

  const scrollAnchor = `  const lastScrollSigRef = useRef<string>('');
  useEffect(() => {
    const lastMsgId = messages?.length ? messages[messages.length - 1].id : '';
    const lastPendingId = queue.pendingMessages.length
      ? queue.pendingMessages[queue.pendingMessages.length - 1].localId
      : '';
    const sig = \`${'${messages?.length ?? 0}'}:${'${lastMsgId}'}|${'${queue.pendingMessages.length}'}:${'${lastPendingId}'}\`;
    if (sig === lastScrollSigRef.current) return;
    lastScrollSigRef.current = sig;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, queue.pendingMessages]);`;
  const stableScroll = `  const lastScrollSigRef = useRef<string>('');
  const lastPendingScrollIdRef = useRef<string>('');
  useEffect(() => {
    const lastMsgId = messages?.length ? messages[messages.length - 1].id : '';
    const lastPendingId = queue.pendingMessages.length
      ? queue.pendingMessages[queue.pendingMessages.length - 1].localId
      : '';
    const sig = \`${'${messages?.length ?? 0}'}:${'${lastMsgId}'}|${'${queue.pendingMessages.length}'}:${'${lastPendingId}'}\`;
    if (sig === lastScrollSigRef.current) return;

    const ownPendingChanged = Boolean(
      lastPendingId && lastPendingId !== lastPendingScrollIdRef.current,
    );
    lastScrollSigRef.current = sig;
    lastPendingScrollIdRef.current = lastPendingId;
    if (!nearBottomRef.current && !ownPendingChanged) return;

    const frame = window.requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({
        behavior: ownPendingChanged ? 'auto' : 'smooth',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, queue.pendingMessages]);`;
  transformed = replaceRequired(
    transformed,
    scrollAnchor,
    stableScroll,
    'ChatView bottom-stick scroll',
  );

  transformed = replaceRequired(
    transformed,
    `  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 200);
  }, []);`,
    `  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    nearBottomRef.current = distanceFromBottom <= 160;
    setShowScrollDown(distanceFromBottom > 200);
  }, []);`,
    'ChatView scroll position tracking',
  );

  const prewarmAnchor = `          pt: decryptedCache.has(msg.id)
            ? null
            : ((await loadPlaintext(msg.id)) ?? (await loadPlaintextForCiphertext(msg.body))),`;
  const prewarmBound = `          pt: decryptedCache.has(msg.id, msg.body)
            ? null
            : ((await loadPlaintextForCiphertext(msg.body)) ?? (await loadPlaintext(msg.id))),`;
  transformed = replaceRequired(
    transformed,
    prewarmAnchor,
    prewarmBound,
    'ChatView ciphertext-first prewarm',
  );

  const onDecryptedAnchor = `  const onDecrypted = useCallback((msgId: string, text: string) => {
    const parsed = parseMediaMessage(text);
    if (parsed) setMediaKey(msgId, parsed.keyB64, isVideoMediaLabel(parsed.label));
    decryptedCache.set(msgId, parsed ? text : text);
    bumpCache();
    void savePlaintext(msgId, parsed ? text : text);
  }, [bumpCache]);`;
  const onDecryptedBound = `  const onDecrypted = useCallback((msgId: string, body: string, text: string) => {
    const parsed = parseMediaMessage(text);
    if (parsed) setMediaKey(msgId, parsed.keyB64, isVideoMediaLabel(parsed.label));
    decryptedCache.set(msgId, text, body);
    bumpCache();
    void savePlaintext(msgId, text);
  }, [bumpCache]);`;
  transformed = replaceRequired(
    transformed,
    onDecryptedAnchor,
    onDecryptedBound,
    'ChatView ciphertext-bound decrypt callback',
  );

  transformed = replaceRequired(
    transformed,
    'onDecrypted={(text) => onDecrypted(msg.id, text)}',
    'onDecrypted={(text) => onDecrypted(msg.id, msg.body, text)}',
    'ChatView decrypt callback body binding',
  );

  transformed = replaceRequired(
    transformed,
    `                        key={msg.id}
                        className={cn(`,
    `                        key={msg.id}
                        data-message-id={msg.id}
                        style={{ contentVisibility: 'auto', contain: 'layout paint style' }}
                        className={cn(`,
    'ChatView offscreen bubble containment',
  );

  transformed = transformed.replaceAll('decryptedCache.get(msg.id)', 'decryptedCache.get(msg.id, msg.body)');
  transformed = transformed.replaceAll('decryptedCache.has(msg.id)', 'decryptedCache.has(msg.id, msg.body)');
  transformed = transformed.replaceAll('decryptedCache.set(msg.id, pt)', 'decryptedCache.set(msg.id, pt, msg.body)');

  const requiredMarkers = [
    'new CiphertextBoundPlaintextCache(2000)',
    'cacheRenderFrameRef.current = window.requestAnimationFrame',
    'nearBottomRef.current = distanceFromBottom <= 160',
    'decryptedCache.has(msg.id, msg.body)',
    'onDecrypted(msg.id, msg.body, text)',
    "contentVisibility: 'auto'",
    'decryptedCache.get(msg.id, msg.body)',
  ];
  for (const marker of requiredMarkers) {
    if (!transformed.includes(marker)) {
      throw new Error(`[bubble-stability] required ChatView transform missing: ${marker}`);
    }
  }
  return transformed;
}

function transformDecryptedMessageBody(code: string): string {
  let transformed = code;
  const importAnchor = "import type { DecryptResult } from '@/hooks/useE2EE';";
  const schedulerImport = "import { scheduleBubbleRecovery } from '@/lib/messaging/bubbleRecoveryScheduler';";
  if (!transformed.includes(schedulerImport)) {
    transformed = replaceRequired(
      transformed,
      importAnchor,
      `${importAnchor}\n${schedulerImport}`,
      'DecryptedMessageBody scheduler import',
    );
  }

  transformed = transformed.replaceAll(
    'readLastGoodOutcome(messageId)',
    'readLastGoodOutcome(messageId, body)',
  );

  const retryAnchor = `  useEffect(() => {
    if (!looksEncrypted(body) || !pending || outcome !== null) {
      silentRetryAttemptRef.current = 0;
      return;
    }

    const attempt = silentRetryAttemptRef.current;
    if (attempt >= SILENT_RETRY_DELAYS_MS.length) return;

    const timer = window.setTimeout(() => {
      silentRetryAttemptRef.current = attempt + 1;
      clearNegativeCache(messageId, body);
      bubbleDiagnostic('DECRYPT_START', {
        messageId,
        reason: 'scheduled_silent_retry',
        details: {
          attempt: attempt + 1,
          delayMs: SILENT_RETRY_DELAYS_MS[attempt],
        },
      });
      setRetryTick((tick) => tick + 1);
    }, SILENT_RETRY_DELAYS_MS[attempt]);

    return () => window.clearTimeout(timer);
  }, [body, messageId, outcome, pending, retryTick]);`;
  const centralRetry = `  useEffect(() => {
    if (!looksEncrypted(body) || !pending || outcome !== null) {
      silentRetryAttemptRef.current = 0;
      return;
    }

    const attempt = silentRetryAttemptRef.current;
    if (attempt >= SILENT_RETRY_DELAYS_MS.length) return;
    const recoveryKey = \`${'${messageId ?? \'noid\'}'}|${'${body}'}\`;

    return scheduleBubbleRecovery(
      recoveryKey,
      SILENT_RETRY_DELAYS_MS[attempt],
      () => {
        silentRetryAttemptRef.current = attempt + 1;
        clearNegativeCache(messageId, body);
        bubbleDiagnostic('DECRYPT_START', {
          messageId,
          reason: 'central_scheduled_retry',
          details: {
            attempt: attempt + 1,
            delayMs: SILENT_RETRY_DELAYS_MS[attempt],
          },
        });
        setRetryTick((tick) => tick + 1);
      },
    );
  }, [body, messageId, outcome, pending, retryTick]);`;
  transformed = replaceRequired(
    transformed,
    retryAnchor,
    centralRetry,
    'DecryptedMessageBody centralized retry',
  );

  const requiredMarkers = [
    "from '@/lib/messaging/bubbleRecoveryScheduler'",
    'readLastGoodOutcome(messageId, body)',
    'return scheduleBubbleRecovery(',
    "reason: 'central_scheduled_retry'",
  ];
  for (const marker of requiredMarkers) {
    if (!transformed.includes(marker)) {
      throw new Error(`[bubble-stability] required body transform missing: ${marker}`);
    }
  }
  return transformed;
}

function transformDecryptionService(code: string): string {
  let transformed = code;
  const stickyAnchor = `const cache = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
const lastGoodByMessage = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
const inflight = new Map<string, Promise<DecryptionOutcome | null>>();

export function readLastGoodOutcome(messageId?: string): DecryptionOutcome | undefined {
  if (!messageId) return undefined;
  return lastGoodByMessage.get(messageId);
}

export function rememberLastGoodOutcome(
  messageId: string | undefined,
  outcome: DecryptionOutcome,
): void {
  if (!messageId || outcome.hidden || outcome.text === '') return;
  lastGoodByMessage.set(messageId, outcome);
}

export function clearLastGoodOutcome(messageId?: string): void {
  if (messageId) {
    lastGoodByMessage.delete(messageId);
    return;
  }
  lastGoodByMessage.clear();
}`;
  const stickyBound = `const cache = new LruMap<string, DecryptionOutcome>(CACHE_CAP);
type LastGoodEntry = { body: string; outcome: DecryptionOutcome };
const lastGoodByMessage = new LruMap<string, LastGoodEntry>(CACHE_CAP);
const inflight = new Map<string, Promise<DecryptionOutcome | null>>();

export function readLastGoodOutcome(
  messageId?: string,
  body?: string,
): DecryptionOutcome | undefined {
  if (!messageId || body === undefined) return undefined;
  const entry = lastGoodByMessage.get(messageId);
  return entry?.body === body ? entry.outcome : undefined;
}

export function rememberLastGoodOutcome(
  messageId: string | undefined,
  outcome: DecryptionOutcome,
  body?: string,
): void {
  if (!messageId || body === undefined || outcome.hidden || outcome.text === '') return;
  lastGoodByMessage.set(messageId, { body, outcome });
}

export function clearLastGoodOutcome(messageId?: string): void {
  if (messageId) {
    lastGoodByMessage.delete(messageId);
    return;
  }
  lastGoodByMessage.clear();
}`;
  transformed = replaceRequired(
    transformed,
    stickyAnchor,
    stickyBound,
    'decryptionService ciphertext-bound sticky result',
  );

  transformed = transformed.replaceAll(
    'rememberLastGoodOutcome(messageId, outcome);',
    'rememberLastGoodOutcome(messageId, outcome, body);',
  );
  transformed = replaceRequired(
    transformed,
    `function stickyOrNull(messageId?: string): DecryptionOutcome | null {
  return readLastGoodOutcome(messageId) ?? null;
}`,
    `function stickyOrNull(messageId: string | undefined, body: string): DecryptionOutcome | null {
  return readLastGoodOutcome(messageId, body) ?? null;
}`,
    'decryptionService body-bound sticky lookup',
  );
  transformed = transformed.replaceAll(
    'stickyOrNull(messageId)',
    'stickyOrNull(messageId, body)',
  );

  const requiredMarkers = [
    'type LastGoodEntry = { body: string; outcome: DecryptionOutcome };',
    'entry?.body === body ? entry.outcome : undefined',
    'rememberLastGoodOutcome(messageId, outcome, body);',
    'stickyOrNull(messageId, body)',
  ];
  for (const marker of requiredMarkers) {
    if (!transformed.includes(marker)) {
      throw new Error(`[bubble-stability] required decryption transform missing: ${marker}`);
    }
  }
  return transformed;
}

function transformMultiDeviceFanout(code: string): string {
  let transformed = code;
  const importAnchor = "import { captureFanoutSessionBeforeMutation } from '@/lib/messaging/fanoutSessionTransaction';";
  const repeatableImport = `import {
  acknowledgeInitiatingSessionFromRatchetPayload,
  createRepeatablePreKeyEnvelope,
  isRepeatablePreKeyEnvelope,
  prepareInitiatingSessionForSend,
  restartExpiredInitiatingSession,
  unwrapRepeatablePreKeyEnvelope,
  wrapRatchetForInitiatingSession,
} from '@/lib/messaging/repeatablePreKeyEnvelope';`;
  if (!transformed.includes(importAnchor)) {
    throw new Error('[repeatable-prekey] transaction import anchor missing');
  }
  if (!transformed.includes(repeatableImport)) {
    transformed = transformed.replace(importAnchor, `${importAnchor}\n${repeatableImport}`);
  }

  const bootstrapAnchor = `  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId, {`;
  const bootstrapV3 = `  if (isKnownInvalidDeviceId(recipientDeviceId)) return null;
  try {
    return await createRepeatablePreKeyEnvelope({
      plaintext,
      senderUserId,
      senderDeviceId,
      recipientUserId,
      recipientDeviceId,
      useOneTimePrekey: options.useOneTimePrekey,
    });
    const bundle = await fetchPrekeyBundleForDevice(recipientUserId, recipientDeviceId, {`;
  if (!transformed.includes('return await createRepeatablePreKeyEnvelope({')) {
    if (!transformed.includes(bootstrapAnchor)) throw new Error('[repeatable-prekey] bootstrap anchor missing');
    transformed = transformed.replace(bootstrapAnchor, bootstrapV3);
  }

  const unwrapAnchor = `  try {
    if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;

    const parsed = parseX3DHBootstrapV5(payload);`;
  const unwrapV3 = `  try {
    if (!payload.startsWith(X3DH_BOOTSTRAP_PREFIX_V5)) return null;

    if (isRepeatablePreKeyEnvelope(payload)) {
      const targetDeviceId = getCurrentDeviceId();
      return unwrapRepeatablePreKeyEnvelope({
        payload,
        recipientUserId,
        recipientDeviceId: targetDeviceId,
        senderUserId,
        senderDeviceId,
        expectedSenderIdentityKeyB64: senderIdentityKeyB64,
      });
    }

    const parsed = parseX3DHBootstrapV5(payload);`;
  if (!transformed.includes('return unwrapRepeatablePreKeyEnvelope({')) {
    if (!transformed.includes(unwrapAnchor)) throw new Error('[repeatable-prekey] unwrap anchor missing');
    transformed = transformed.replace(unwrapAnchor, unwrapV3);
  }

  const sessionPreparationAnchor = `  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await invalidateDeviceSession(input.senderUserId, senderDeviceId, input.recipientUserId, input.recipientDeviceId).catch(() => {});
  }

  let encrypted: string | null = null;`;
  const sessionPreparationV3 = `  const senderDeviceId = input.senderDeviceId ?? getCurrentDeviceId();

  if (input.forceFreshSession) {
    await restartExpiredInitiatingSession({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    }).catch(() => undefined);
  } else {
    const initiatingState = await prepareInitiatingSessionForSend({
      myUserId: input.senderUserId,
      myDeviceId: senderDeviceId,
      peerUserId: input.recipientUserId,
      peerDeviceId: input.recipientDeviceId,
    });
    if (initiatingState === 'restart') {
      await restartExpiredInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
      });
    }
  }

  let encrypted: string | null = null;`;
  if (!transformed.includes('const initiatingState = await prepareInitiatingSessionForSend({')) {
    if (!transformed.includes(sessionPreparationAnchor)) throw new Error('[repeatable-prekey] send preparation anchor missing');
    transformed = transformed.replace(sessionPreparationAnchor, sessionPreparationV3);
  }

  const ratchetReturnAnchor = `    if (encrypted && encrypted.startsWith(RATCHET_PREFIX_V5)) {
      return { encryptedBody: encrypted, senderDeviceId };
    }`;
  const ratchetReturnV3 = `    if (encrypted && encrypted.startsWith(RATCHET_PREFIX_V5)) {
      encrypted = await wrapRatchetForInitiatingSession({
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: input.recipientUserId,
        peerDeviceId: input.recipientDeviceId,
        ratchetPayload: encrypted,
      });
      return { encryptedBody: encrypted, senderDeviceId };
    }`;
  if (!transformed.includes('encrypted = await wrapRatchetForInitiatingSession({')) {
    if (!transformed.includes(ratchetReturnAnchor)) throw new Error('[repeatable-prekey] ratchet wrap anchor missing');
    transformed = transformed.replace(ratchetReturnAnchor, ratchetReturnV3);
  }

  const identityAnchor = `      const parsed = parseX3DHBootstrapV5(row.encrypted_body);
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key && parsed?.version !== 'v2') {`;
  const identityV3 = `      const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);
      const parsed = repeatable ? null : parseX3DHBootstrapV5(row.encrypted_body);
      const { data: senderPub } = await supabase.from('user_public_keys').select('identity_key').eq('user_id', row.sender_user_id).eq('is_active', true).maybeSingle();
      if (!senderPub?.identity_key && !repeatable && parsed?.version !== 'v2') {`;
  if (!transformed.includes('const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);')) {
    if (!transformed.includes(identityAnchor)) throw new Error('[repeatable-prekey] identity anchor missing');
    transformed = transformed.replace(identityAnchor, identityV3);
  }

  const acknowledgementAnchor = `      if (pt === null) {
        await invalidateDeviceSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id).catch(() => {});
      }
      return {`;
  const acknowledgementV3 = `      if (pt === null) {
        await invalidateDeviceSession(userId, myDeviceId, row.sender_user_id, row.sender_device_id).catch(() => {});
      } else {
        await acknowledgeInitiatingSessionFromRatchetPayload({
          myUserId: userId,
          myDeviceId,
          peerUserId: row.sender_user_id,
          peerDeviceId: row.sender_device_id,
          ratchetPayload: row.encrypted_body,
        }).catch(() => undefined);
      }
      return {`;
  if (!transformed.includes('await acknowledgeInitiatingSessionFromRatchetPayload({')) {
    if (!transformed.includes(acknowledgementAnchor)) throw new Error('[repeatable-prekey] acknowledgement anchor missing');
    transformed = transformed.replace(acknowledgementAnchor, acknowledgementV3);
  }

  const requiredMarkers = [
    "from '@/lib/messaging/repeatablePreKeyEnvelope'",
    'return await createRepeatablePreKeyEnvelope({',
    'return unwrapRepeatablePreKeyEnvelope({',
    'const initiatingState = await prepareInitiatingSessionForSend({',
    'encrypted = await wrapRatchetForInitiatingSession({',
    'const repeatable = isRepeatablePreKeyEnvelope(row.encrypted_body);',
    'await acknowledgeInitiatingSessionFromRatchetPayload({',
  ];
  for (const marker of requiredMarkers) {
    if (!transformed.includes(marker)) {
      throw new Error(`[repeatable-prekey] required transform missing: ${marker}`);
    }
  }
  return transformed;
}

/**
 * Build-time guards for the Signal/Sesame transport and stable message-bubble
 * rendering. The large legacy components stay source-compatible with Lovable,
 * while every safety/performance injection is asserted during production build.
 */
export function repeatablePreKeyEnvelopeGuard(): Plugin {
  return {
    name: 'forsure-repeatable-prekey-envelope-guard',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = id.split('?', 1)[0].replace(/\\/g, '/');
      if (cleanId.endsWith('/src/components/messages/ChatView.tsx')) {
        const transformed = transformChatView(code);
        return transformed === code ? null : { code: transformed, map: null };
      }
      if (cleanId.endsWith('/src/components/messages/DecryptedMessageBody.tsx')) {
        const transformed = transformDecryptedMessageBody(code);
        return transformed === code ? null : { code: transformed, map: null };
      }
      if (cleanId.endsWith('/src/components/messages/decryptionService.ts')) {
        const transformed = transformDecryptionService(code);
        return transformed === code ? null : { code: transformed, map: null };
      }
      if (cleanId.endsWith('/src/lib/messaging/multiDeviceFanout.ts')) {
        const transformed = transformMultiDeviceFanout(code);
        return transformed === code ? null : { code: transformed, map: null };
      }
      return null;
    },
  };
}
