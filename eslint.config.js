import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: [
      "src/lib/crypto/deviceList.ts",
      "src/lib/crypto/encryptedSessionSync.ts",
      "src/lib/crypto/ratchet.ts",
      "src/lib/crypto/x3dhBundleSafe.ts",
    ],
    rules: {
      // These boundary modules bridge generated Supabase types and WebCrypto
      // definitions that do not fully model X25519/Ed25519 yet. Keep every use
      // visible as a warning without blocking the incremental lint gate.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
