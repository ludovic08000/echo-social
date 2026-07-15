import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

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

        // While the PIN session is unlocked, the local identity and ratchet
        // material must remain readable by bubble decryptors. The crypto blob is
        // already encrypted and persisted here; deletion belongs exclusively to
        // lockWithoutWiping(), not setup/verify success.
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

      if (cleanId.endsWith("/src/hooks/useDeviceRegistration.ts")) {
        let transformed = code;
        const sessionImport = "import { requireAuthenticatedDeviceSession } from '@/lib/device-manager/sessionGate';";
        if (!transformed.includes(sessionImport)) {
          const importAnchor = "import { useEffect, useRef } from 'react';";
          transformed = transformed.replace(importAnchor, `${importAnchor}\n${sessionImport}`);
        }
        const registrationAnchor = "      try {\n        console.log('[useDeviceRegistration] publishing current device', { reason, attempt });";
        const guardedAnchor = "      try {\n        await requireAuthenticatedDeviceSession(user.id);\n        console.log('[useDeviceRegistration] publishing current device', { reason, attempt });";
        if (!transformed.includes(guardedAnchor)) {
          transformed = transformed.replace(registrationAnchor, guardedAnchor);
        }
        return transformed === code ? null : { code: transformed, map: null };
      }

      return null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: { overlay: false },
  },
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
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "favicon.ico", "og-image.png"],
      workbox: {
        cacheId: "forsure-e2ee-final-v2",
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
              cacheName: "supabase-storage-e2ee-final-v2",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(png|jpg|jpeg|gif|webp|avif|svg)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "images-e2ee-final-v2",
              expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(woff2?|ttf|otf|eot)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts-e2ee-final-v2",
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
        start_url: "/?v=e2ee-final-v2",
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
      {
        find: /^@\/hooks\/useMessages$/,
        replacement: path.resolve(__dirname, "./src/hooks/useMessagesStable.ts"),
      },
      {
        find: /^@\/lib\/messaging\/currentDevice$/,
        replacement: path.resolve(__dirname, "./src/lib/device-manager/currentDevice.ts"),
      },
      {
        find: /^@\/lib\/crypto\/resyncE2EE$/,
        replacement: path.resolve(__dirname, "./src/lib/device-manager/resync.ts"),
      },
      {
        find: /^@\/lib\/crypto\/devicePrekeyRepair$/,
        replacement: path.resolve(__dirname, "./src/lib/device-manager/prekeyRepair.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
}));