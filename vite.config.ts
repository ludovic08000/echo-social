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
        cacheId: "forsure-e2ee-final-v1",
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
              cacheName: "supabase-storage-e2ee-final-v1",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(png|jpg|jpeg|gif|webp|avif|svg)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "images-e2ee-final-v1",
              expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(woff2?|ttf|otf|eot)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts-e2ee-final-v1",
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
        start_url: "/?v=e2ee-final-v1",
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
