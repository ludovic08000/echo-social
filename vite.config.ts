import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { repeatablePreKeyEnvelopeGuard } from "./vite.repeatable-prekey-plugin";

/**
 * Guarded source fixes for oversized UI modules. They are deterministic and
 * idempotent, and apply in development, tests and production builds.
 */
function messagingStabilityGuard(): Plugin {
  return {
    name: "forsure-messaging-stability-guard",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?", 1)[0].replace(/\\/g, "/");

      if (cleanId.endsWith("/src/components/messages/ChatView.tsx")) {
        let transformed = code;
        transformed = transformed.replace(
          "groupedMessages.map((group, gi) => (",
          "groupedMessages.map((group) => (",
        );
        transformed = transformed.replace(
          "<div key={gi}>",
          "<div key={format(new Date(group.date), 'yyyy-MM-dd')}>",
        );

        const mediaMarker = `                                messageId={msg.id}
                               />`;
        const mediaStableMarker = `                                messageId={msg.id}
                                 cachedPlaintext={decryptedCache.get(msg.id)}
                               />`;
        if (!transformed.includes(mediaStableMarker)) {
          transformed = transformed.replace(mediaMarker, mediaStableMarker);
        }

        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/components/MessagingPinGate.tsx")) {
        let transformed = code;
        const trustImport = "import { PinValidatedMessaging } from '@/components/PinValidatedMessaging';";
        if (!transformed.includes(trustImport)) {
          const importAnchor = "import { motion, AnimatePresence } from 'framer-motion';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${trustImport}`);
        }
        transformed = transformed.replace(
          "if (pin.unlocked) return <>{children}</>;",
          "if (pin.unlocked) return <PinValidatedMessaging>{children}</PinValidatedMessaging>;",
        );
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/hooks/useChatPin.ts")) {
        let transformed = code;
        transformed = transformed.replace(
          `        await encryptAndSaveWrappedCrypto(user.id, wrapKey, saltB64, fullBlob);
        await deleteRawIdentityBlob(user.id);
        console.log('[PIN] Full crypto blob wrapped (v2)');`,
          `        await encryptAndSaveWrappedCrypto(user.id, wrapKey, saltB64, fullBlob);
        console.log('[PIN] Full crypto blob wrapped and kept active for this unlocked session (v2)');`,
        );
        transformed = transformed.replace(
          `            await encryptAndSaveWrappedCrypto(user.id, wrapKey, verifyResult.salt, fullBlob);
            await deleteRawIdentityBlob(user.id);
            console.log('[PIN] Full crypto blob wrapped on first verify (v2)');`,
          `            await encryptAndSaveWrappedCrypto(user.id, wrapKey, verifyResult.salt, fullBlob);
            console.log('[PIN] Full crypto blob wrapped on first verify and kept active (v2)');`,
        );
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/components/messages/decryptionService.ts")) {
        let transformed = code;
        const hotImport = "import { readHotPlaintext, writeHotPlaintext } from '@/lib/crypto/plaintextHotCache';";
        if (!transformed.includes(hotImport)) {
          const importAnchor = "import { decryptArchive, isArchivePayload } from '@/lib/messaging/archive/archiveKey';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${hotImport}`);
        }

        const readCacheAnchor = `export function readCache(messageId: string | undefined, body: string): DecryptionOutcome | undefined {
  return cache.get(cacheKey(messageId, body));
}`;
        const readCacheHot = `export function readCache(messageId: string | undefined, body: string): DecryptionOutcome | undefined {
  const key = cacheKey(messageId, body);
  const memoryCached = cache.get(key);
  if (memoryCached) return memoryCached;
  const hotPlaintext = readHotPlaintext(messageId, body);
  if (!hotPlaintext) return undefined;
  const outcome = buildOutcomeFromText(hotPlaintext);
  cache.set(key, outcome);
  rememberLastGoodOutcome(messageId, outcome);
  return outcome;
}`;
        transformed = transformed.replace(readCacheAnchor, readCacheHot);

        const persistAnchor = `  rememberLastGoodOutcome(messageId, outcome);
  if (messageId) void savePlaintext(messageId, persisted);`;
        const persistHot = `  rememberLastGoodOutcome(messageId, outcome);
  writeHotPlaintext(messageId, body, persisted);
  if (messageId) void savePlaintext(messageId, persisted);`;
        if (!transformed.includes("writeHotPlaintext(messageId, body, persisted);")) {
          transformed = transformed.replace(persistAnchor, persistHot);
        }

        const byMessageAnchor = `  if (byMessageId) {
    if (looksEncrypted(body)) void savePlaintextForCiphertext(body, byMessageId);
    const outcome = buildOutcomeFromText(byMessageId);`;
        const byMessageHot = `  if (byMessageId) {
    writeHotPlaintext(messageId, body, byMessageId);
    if (looksEncrypted(body)) void savePlaintextForCiphertext(body, byMessageId);
    const outcome = buildOutcomeFromText(byMessageId);`;
        transformed = transformed.replace(byMessageAnchor, byMessageHot);

        const byCipherAnchor = `  if (!byCiphertext) return null;
  if (messageId) void savePlaintext(messageId, byCiphertext);
  const outcome = buildOutcomeFromText(byCiphertext);`;
        const byCipherHot = `  if (!byCiphertext) return null;
  writeHotPlaintext(messageId, body, byCiphertext);
  if (messageId) void savePlaintext(messageId, byCiphertext);
  const outcome = buildOutcomeFromText(byCiphertext);`;
        transformed = transformed.replace(byCipherAnchor, byCipherHot);
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/lib/crypto/deviceRatchet.ts")) {
        let transformed = code;
        const saveAnchor = `async function saveSession(key: string, session: StoredSession): Promise<void> {
  try {
    await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
      tx.objectStore(STORE).put({ ...session, id: key });
    });
  } catch {
    // non-fatal
  }
}`;
        const saveFailClosed = `async function saveSession(key: string, session: StoredSession): Promise<void> {
  await runTxOn('device-sessions', [STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE).put({ ...session, id: key });
  });
}`;
        transformed = transformed.replace(saveAnchor, saveFailClosed);
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/lib/crypto/x3dh.ts")) {
        let transformed = code;
        const signatureAnchor = `export async function x3dhRespondForDevice(myKeys: IdentityKeyPair, myUserId: string, myDeviceId: string, initialMessage: X3DHInitialMessage): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  const { assertNotReplayedAndRecord } = await import('./x3dhReplayGuard');
  await assertNotReplayedAndRecord({ myUserId: \`${'${myUserId}'}::${'${myDeviceId}'}\`, ik: initialMessage.ik, ek: initialMessage.ek, spkId: initialMessage.spkId, opkId: initialMessage.opkId });`;
        const signatureTwoPhase = `export async function x3dhRespondForDevice(myKeys: IdentityKeyPair, myUserId: string, myDeviceId: string, initialMessage: X3DHInitialMessage): Promise<{
  sharedSecret: ArrayBuffer;
  spkKeyPair: CryptoKeyPair;
  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation;
  usedOpkId?: number;
}> {
  const { reserveX3dhInitial } = await import('./x3dhReplayGuard');
  const replayReservation = await reserveX3dhInitial({ myUserId: \`${'${myUserId}'}::${'${myDeviceId}'}\`, ik: initialMessage.ik, ek: initialMessage.ek, spkId: initialMessage.spkId, opkId: initialMessage.opkId });`;
        transformed = transformed.replace(signatureAnchor, signatureTwoPhase);
        transformed = transformed.replace(
          `    await deleteDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);`,
          `    // OPK deletion is deferred until the bootstrap ciphertext has been
    // authenticated and the responder ratchet has been persisted.`,
        );
        transformed = transformed.replace(
          `  return { sharedSecret, spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate } };
}

export function isPQXDHAvailable(): boolean { return false; }`,
          `  return {
    sharedSecret,
    spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },
    replayReservation,
    usedOpkId: initialMessage.opkId,
  };
}

export async function finalizeDeviceX3DHInitial(args: {
  userId: string;
  deviceId: string;
  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation;
  usedOpkId?: number;
}): Promise<void> {
  const { finalizeX3dhInitial } = await import('./x3dhReplayGuard');
  await finalizeX3dhInitial(args.replayReservation);
  if (args.usedOpkId !== undefined) {
    await deleteDeviceOPKPrivate(args.userId, args.deviceId, args.usedOpkId);
  }
}

export async function cancelDeviceX3DHInitial(
  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation,
): Promise<void> {
  const { cancelX3dhInitial } = await import('./x3dhReplayGuard');
  await cancelX3dhInitial(replayReservation);
}

export function isPQXDHAvailable(): boolean { return false; }`,
        );
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/lib/messaging/multiDeviceFanout.ts")) {
        let transformed = code;
        const routeImport = "import { resolveFanoutRoute } from '@/lib/messaging/fanoutRouteCache';";
        const transactionImport = "import { captureFanoutSessionBeforeMutation } from '@/lib/messaging/fanoutSessionTransaction';";
        if (!transformed.includes(routeImport)) {
          const importAnchor = "import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${routeImport}`);
        }
        if (!transformed.includes(transactionImport)) {
          transformed = transformed.replace(routeImport, `${routeImport}\n${transactionImport}`);
        }
        transformed = transformed.replace(
          `  x3dhRespondForDevice,
} from '@/lib/crypto/x3dh';`,
          `  x3dhRespondForDevice,
  finalizeDeviceX3DHInitial,
  cancelDeviceX3DHInitial,
} from '@/lib/crypto/x3dh';`,
        );
        transformed = transformed.replace("const FANOUT_ENCRYPT_CONCURRENCY = 4;", "const FANOUT_ENCRYPT_CONCURRENCY = 8;");

        const routeAnchor = `  const { data: participants } = await supabase.from('conversation_participants').select('user_id').eq('conversation_id', input.conversationId);
  if (!participants?.length) return { rows: [], hasTargets: false };
  const userIds = participants.map(p => p.user_id);

  const targets = (await listFanoutTargets(input.senderUserId, userIds, { verifyPrekeys: false }))
    .filter(d =>
      !(d.userId === input.senderUserId && d.deviceId === senderDeviceId) &&
      !isKnownInvalidDeviceId(d.deviceId),
    );`;
        const routeFast = `  const targets = (await resolveFanoutRoute(input.conversationId, input.senderUserId))
    .filter((device) => !isKnownInvalidDeviceId(device.deviceId));`;
        transformed = transformed.replace(routeAnchor, routeFast);

        const encryptAnchor = `    try {
      const encrypted = await encryptPlaintextForDeviceTarget({`;
        const transactionalEncrypt = `    try {
      await captureFanoutSessionBeforeMutation({
        messageId: input.messageId,
        myUserId: input.senderUserId,
        myDeviceId: senderDeviceId,
        peerUserId: dev.userId,
        peerDeviceId: dev.deviceId,
      });
      const encrypted = await encryptPlaintextForDeviceTarget({`;
        if (!transformed.includes("captureFanoutSessionBeforeMutation({")) {
          transformed = transformed.replace(encryptAnchor, transactionalEncrypt);
        }

        const unwrapAnchor = `    const { sharedSecret, spkKeyPair } = await x3dhRespondForDevice(myKeys, recipientUserId, myDeviceId, {
      ik: senderIdentityForDH,
      ek: parsed.ekB64,
      spkId: parsed.spkId,
      opkId: parsed.opkId,
    });
    const aes = await aesFromSecret(sharedSecret);
    const aad = parsed.version === 'v2'
      ? buildX3DHBootstrapAAD({
          senderUserId,
          senderDeviceId,
          recipientUserId,
          recipientDeviceId: myDeviceId,
          senderIdentityKeyB64: senderIdentityForDH,
          recipientIdentityKeyB64: parsed.recipientIdentityKeyB64!,
          ekB64: parsed.ekB64,
          spkId: parsed.spkId,
          opkId: parsed.opkId,
        })
      : null;
    const pt = await hardCrypto.decrypt(
      aad
        ? { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> }
        : { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128 },
      aes,
      base64ToBuffer(parsed.ctB64),
    );

    try {
      const spkPrivJwk = await hardCrypto.exportKey('jwk', spkKeyPair.privateKey);
      const spkPubRaw = await hardCrypto.exportKey('raw', spkKeyPair.publicKey);
      const spkPubB64 = bufferToBase64(spkPubRaw as ArrayBuffer);
      await establishDeviceSession(
        recipientUserId, myDeviceId,
        senderUserId, senderDeviceId,
        sharedSecret,
        undefined,
        {
          isInitiator: false,
          peerSpkId: parsed.spkId,
          selfInitialDhPrivJwk: spkPrivJwk,
          selfInitialDhPubB64: spkPubB64,
        },
      );
    } catch {}

    return new hardGlobals.TextDecoder().decode(pt);`;
        const unwrapTwoPhase = `    const response = await x3dhRespondForDevice(myKeys, recipientUserId, myDeviceId, {
      ik: senderIdentityForDH,
      ek: parsed.ekB64,
      spkId: parsed.spkId,
      opkId: parsed.opkId,
    });
    try {
      const aes = await aesFromSecret(response.sharedSecret);
      const aad = parsed.version === 'v2'
        ? buildX3DHBootstrapAAD({
            senderUserId,
            senderDeviceId,
            recipientUserId,
            recipientDeviceId: myDeviceId,
            senderIdentityKeyB64: senderIdentityForDH,
            recipientIdentityKeyB64: parsed.recipientIdentityKeyB64!,
            ekB64: parsed.ekB64,
            spkId: parsed.spkId,
            opkId: parsed.opkId,
          })
        : null;
      const pt = await hardCrypto.decrypt(
        aad
          ? { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> }
          : { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(parsed.ivB64)), tagLength: 128 },
        aes,
        base64ToBuffer(parsed.ctB64),
      );

      const spkPrivJwk = await hardCrypto.exportKey('jwk', response.spkKeyPair.privateKey);
      const spkPubRaw = await hardCrypto.exportKey('raw', response.spkKeyPair.publicKey);
      const spkPubB64 = bufferToBase64(spkPubRaw as ArrayBuffer);
      await establishDeviceSession(
        recipientUserId, myDeviceId,
        senderUserId, senderDeviceId,
        response.sharedSecret,
        undefined,
        {
          isInitiator: false,
          peerSpkId: parsed.spkId,
          selfInitialDhPrivJwk: spkPrivJwk,
          selfInitialDhPubB64: spkPubB64,
        },
      );
      await finalizeDeviceX3DHInitial({
        userId: recipientUserId,
        deviceId: myDeviceId,
        replayReservation: response.replayReservation,
        usedOpkId: response.usedOpkId,
      });
      return new hardGlobals.TextDecoder().decode(pt);
    } catch (error) {
      await cancelDeviceX3DHInitial(response.replayReservation).catch(() => undefined);
      throw error;
    }`;
        transformed = transformed.replace(unwrapAnchor, unwrapTwoPhase);
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/hooks/useMessageQueueSignal.ts")) {
        let transformed = code;
        const warmImport = "import { warmFanoutRoute } from '@/lib/messaging/fanoutRouteCache';";
        const sesameImport = "import { sendMessageWithSesameRetry } from '@/lib/messaging/sesameSendRpc';";
        const rollbackImport = "import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';";
        const deviceImport = "import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';";
        if (!transformed.includes(warmImport)) {
          const importAnchor = "import { buildFanoutCopies, insertFanoutCopyRows, type FanoutCopyRow } from '@/lib/messaging/multiDeviceFanout';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${warmImport}`);
        }
        for (const extraImport of [sesameImport, rollbackImport, deviceImport]) {
          if (!transformed.includes(extraImport)) transformed = transformed.replace(warmImport, `${warmImport}\n${extraImport}`);
        }
        transformed = transformed.replace("const INLINE_ARCHIVE_BUDGET_MS = 180;", "const INLINE_ARCHIVE_BUDGET_MS = 40;");

        const stateAnchor = `  const queryClient = useQueryClient();
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);`;
        const stateFast = `  const queryClient = useQueryClient();
  const [pendingMessages, setPendingMessages] = useState<OutboundMessage[]>([]);

  useEffect(() => {
    if (!user?.id || !conversationId) return;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    console.info('[MSG_TRACE]', { stage: 'route_warm_started', elapsedMs: 0, conversationId, userId: user.id });
    void warmFanoutRoute(conversationId, user.id)
      .then(() => console.info('[MSG_TRACE]', {
        stage: 'route_warm_ready',
        elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt),
        conversationId,
        userId: user.id,
      }))
      .catch((error) => console.warn('[MSG_TRACE] route_warm_deferred', {
        conversationId,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      }));
  }, [conversationId, user?.id]);`;
        transformed = transformed.replace(stateAnchor, stateFast);
        transformed = transformed.replace("    const traceId = safeUUID();", "    const traceId = safeUUID();\n    const serverMessageId = safeUUID();");
        transformed = transformed.replace(
          `      createdAt: now,
      updatedAt: now,
      serverId: null,
    };
    let outboxSnapshot: OutboxPayload = {
      ...optimistic,
      extra,
      reservedServerId: null,`,
          `      createdAt: now,
      updatedAt: now,
      serverId: serverMessageId,
    };
    let outboxSnapshot: OutboxPayload = {
      ...optimistic,
      extra,
      reservedServerId: serverMessageId,`,
        );
        transformed = transformed.replace(
          "      new Promise<{ kind: 'slow' }>((resolve) => setTimeout(() => resolve({ kind: 'slow' }), 800)),",
          "      new Promise<{ kind: 'slow' }>((resolve) => setTimeout(() => resolve({ kind: 'slow' }), 100)),",
        );
        transformed = transformed.replace(
          `    updatePending({ status: 'sending' });
    const serverMessageId = safeUUID();
    outboxSnapshot = { ...outboxSnapshot, reservedServerId: serverMessageId, updatedAt: Date.now() };
    void putOutboxPayload(user.id, outboxSnapshot).catch(() => {});`,
          `    updatePending({ status: 'sending', serverId: serverMessageId });`,
        );
        transformed = transformed.replace(
          `    if (encryptedSuccessfully) {
      fanoutPromise = buildFanoutCopies(fanoutInput);`,
          `    if (encryptedSuccessfully) {
      trace('fanout_started');
      fanoutPromise = buildFanoutCopies(fanoutInput).catch(async (error) => {
        await rollbackFanoutSessionTransaction(serverMessageId).catch(() => 0);
        throw error;
      });`,
        );
        transformed = transformed.replace(
          `      if (inlineFanout) {
        fanoutRows = inlineFanout.rows;
        fanoutHasTargets = inlineFanout.hasTargets;
        fanoutTimedOut = fanoutNeedsRepair(inlineFanout);
      } else {
        fanoutTimedOut = true;
      }`,
          `      if (inlineFanout) {
        fanoutRows = inlineFanout.rows;
        fanoutHasTargets = inlineFanout.hasTargets;
        fanoutTimedOut = fanoutNeedsRepair(inlineFanout);
      } else {
        trace('fanout_slow_waiting_for_security');
        const completedFanout = await fanoutPromise;
        fanoutRows = completedFanout.rows;
        fanoutHasTargets = completedFanout.hasTargets;
        fanoutTimedOut = fanoutNeedsRepair(completedFanout);
      }
      trace('fanout_ready', { rows: fanoutRows.length, hasTargets: fanoutHasTargets, needsRepair: fanoutTimedOut });`,
        );

        const rpcBlock = `    const { data: rpcMessageId, error } = await supabase.rpc('send_message_with_device_copies', {
      p_message_id: serverMessageId,
      p_conversation_id: conversationId,
      p_body: bodyToStore,
      p_image_url: imageUrl || null,
      p_extra: rpcExtra as never,
      p_copies: fanoutRows as never,
    });`;
        const sesameRpc = `    trace('rpc_start', { copies: fanoutRows.length });
    const sesameResult = await sendMessageWithSesameRetry({
      messageId: serverMessageId,
      conversationId,
      body: bodyToStore,
      imageUrl: imageUrl || null,
      extra: rpcExtra,
      senderUserId: user.id,
      senderDeviceId: getCurrentDeviceId(),
      initialCopies: fanoutRows,
      rebuildCopies: async () => (await buildFanoutCopies(fanoutInput)).rows,
    });
    fanoutRows = sesameResult.copies;
    const rpcMessageId = sesameResult.data;
    const error = sesameResult.error;
    trace('rpc_done', {
      ok: !error,
      staleRouteRetried: sesameResult.retriedStaleRoute,
      compatibilitySignature: sesameResult.usedCompatibilitySignature,
      copies: fanoutRows.length,
    });`;
        transformed = transformed.replace(rpcBlock, sesameRpc);
        transformed = transformed.replace(
          `      if (!shouldFallbackToLegacyEncryptedInsert(error)) {`,
          `      if (encryptionWasRequired || !shouldFallbackToLegacyEncryptedInsert(error)) {`,
        );
        transformed = transformed.replace(
          `      await onMessageSent?.(localId);
      await deleteOutboxPayload(localId).catch(() => {});
      setPendingMessages(prev => prev.filter(message => message.localId !== localId));`,
          `      setPendingMessages(prev => prev.filter(message => message.localId !== localId));
      void Promise.resolve(onMessageSent?.(localId)).catch(() => {});
      void deleteOutboxPayload(localId).catch(() => {});`,
        );
        return transformed === code ? null : { code: transformed, map: null };
      }

      if (cleanId.endsWith("/src/hooks/useDeviceRegistration.ts")) {
        let transformed = code;
        const sessionImport = "import { requireAuthenticatedDeviceSession } from '@/lib/device-manager/sessionGate';";
        if (!transformed.includes(sessionImport)) {
          const importAnchor = "import { useEffect, useRef } from 'react';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${sessionImport}`);
        }
        const registrationAnchor = "      try {\n        console.log('[useDeviceRegistration] publishing current device', { reason, attempt });";
        const guardedAnchor = "      try {\n        await requireAuthenticatedDeviceSession(user.id);\n        console.log('[useDeviceRegistration] publishing current device', { reason, attempt });";
        if (!transformed.includes(guardedAnchor)) transformed = transformed.replace(registrationAnchor, guardedAnchor);
        return transformed === code ? null : { code: transformed, map: null };
      }

      return null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  server: { host: "::", port: 8080, hmr: { overlay: false } },
  build: {
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: `assets/index-e2ee-final-[hash].js`,
        chunkFileNames: `assets/[name]-e2ee-final-[hash].js`,
        assetFileNames: `assets/[name]-e2ee-final-[hash][extname]`,
      },
    },
  },
  plugins: [
    messagingStabilityGuard(),
    repeatablePreKeyEnvelopeGuard(),
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "favicon.ico", "og-image.png"],
      workbox: {
        cacheId: "forsure-e2ee-final-v5",
        maximumFileSizeToCacheInBytes: 5242880,
        navigateFallbackDenylist: [/^\/~oauth/],
        globPatterns: ["**/*.{js,css,html,ico,svg,woff2}"],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/vkpmoqfzrihcijjochks\.supabase\.co\/storage\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "supabase-storage-e2ee-final-v5",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(png|jpg|jpeg|gif|webp|avif|svg)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "images-e2ee-final-v5",
              expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(woff2?|ttf|otf|eot)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts-e2ee-final-v5",
              expiration: { maxEntries: 20, maxAgeSeconds: 365 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        name: "Forsure — Réseau social",
        short_name: "Forsure",
        description: "Le réseau social éthique, sans tracking publicitaire.",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/?v=e2ee-final-v5",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: [
      { find: /^@\/hooks\/useMessages$/, replacement: path.resolve(__dirname, "./src/hooks/useMessagesStable.ts") },
      { find: /^@\/lib\/messaging\/currentDevice$/, replacement: path.resolve(__dirname, "./src/lib/device-manager/currentDevice.ts") },
      { find: /^@\/lib\/crypto\/resyncE2EE$/, replacement: path.resolve(__dirname, "./src/lib/device-manager/resync.ts") },
      { find: /^@\/lib\/crypto\/devicePrekeyRepair$/, replacement: path.resolve(__dirname, "./src/lib/device-manager/prekeyRepair.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
}));
