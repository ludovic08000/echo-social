import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  server: { host: "::", port: 8080, hmr: { overlay: false } },
  build: {
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: `assets/index-aegis-v1-[hash].js`,
        chunkFileNames: `assets/[name]-aegis-v1-[hash].js`,
        assetFileNames: `assets/[name]-aegis-v1-[hash][extname]`,
      },
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "favicon.ico", "og-image.png"],
      workbox: {
        cacheId: "forsure-aegis-v1",
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
              cacheName: "supabase-storage-aegis-v1",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(png|jpg|jpeg|gif|webp|avif|svg)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "images-aegis-v1",
              expiration: { maxEntries: 150, maxAgeSeconds: 30 * 24 * 3600 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: /\.(woff2?|ttf|otf|eot)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts-aegis-v1",
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
        start_url: "/?v=aegis-v1",
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
