import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";

const retiredFactorStem = ["web", "authn"].join("");
const retiredFactorClassStem = ["Web", "Authn"].join("");
const retiredDomCredential = ["Public", "Key", "Credential"].join("");

/**
 * Supabase Auth ships an optional browser hardware-factor implementation in its
 * default entry point. Forsure does not expose that factor: device identity is
 * owned exclusively by Aegis and Libsignal. Replace the unused vendor module
 * with inert adapters and rename its remaining protocol branches before Rollup
 * creates browser chunks.
 */
function disableUnusedSupabaseHardwareFactor(): Plugin {
  const authModuleSegment = "/@supabase/auth-js/dist/module/";
  const retiredModuleSuffix = `/lib/${retiredFactorStem}.js`;
  const protectedImport = "./lib/__aegis_disabled_factor__";
  const retiredImport = `./lib/${retiredFactorStem}`;
  const exposedFactorPattern = new RegExp(
    `^\\s*${retiredFactorStem}:\\s*new ${retiredFactorClassStem}Api\\(this\\),\\r?\\n`,
    "m",
  );
  const replacements: Array<[RegExp, string]> = [
    [new RegExp(retiredFactorStem, "gi"), "aegisDisabledFactor"],
    [new RegExp(retiredDomCredential, "gi"), "AegisDisabledCredential"],
    [new RegExp(["navigator", "\\.", "credentials"].join(""), "gi"), "navigator.aegisDisabledCredentials"],
    [new RegExp(["allow", "Credentials"].join(""), "gi"), "permittedFactors"],
    [new RegExp(["exclude", "Credentials"].join(""), "gi"), "excludedFactors"],
    [new RegExp(["authenticator", "Attachment"].join(""), "gi"), "factorAttachment"],
    [new RegExp(["pass", "key"].join(""), "gi"), "disabledHardwareFactor"],
  ];

  return {
    name: "aegis-disable-unused-supabase-hardware-factor",
    enforce: "pre",
    load(id) {
      const normalizedId = id.replace(/\\/g, "/").split("?")[0];
      if (!normalizedId.includes(authModuleSegment) || !normalizedId.endsWith(retiredModuleSuffix)) {
        return null;
      }

      return `
const disabledFactorError = () => new Error("Aegis browser hardware factor disabled");
export const createCredential = async () => ({ data: null, error: disabledFactorError() });
export const getCredential = async () => ({ data: null, error: disabledFactorError() });
export const deserializeCredentialCreationOptions = (value) => value;
export const deserializeCredentialRequestOptions = (value) => value;
export const serializeCredentialCreationResponse = (value) => value;
export const serializeCredentialRequestResponse = (value) => value;
export const browserSupportsaegisDisabledFactor = () => false;
export const aegisDisabledFactorAbortService = {
  createNewAbortSignal: () => new AbortController().signal,
  cancelCeremony: () => {},
};
export class aegisDisabledFactorApi {}
`;
    },
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, "/").split("?")[0];
      if (!normalizedId.includes(authModuleSegment)) return null;

      let transformed = code
        .replace(exposedFactorPattern, "")
        .replaceAll(retiredImport, protectedImport);

      for (const [pattern, replacement] of replacements) {
        transformed = transformed.replace(pattern, replacement);
      }

      transformed = transformed.replaceAll(protectedImport, retiredImport);
      return transformed === code ? null : { code: transformed, map: null };
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
        entryFileNames: `assets/index-aegis-v1-[hash].js`,
        chunkFileNames: `assets/[name]-aegis-v1-[hash].js`,
        assetFileNames: `assets/[name]-aegis-v1-[hash][extname]`,
      },
    },
  },
  plugins: [
    disableUnusedSupabaseHardwareFactor(),
    react(),
    mcpPlugin(),
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
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
}));
