import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Browser assets are public by definition. Block accidental publication of the
// repository, server sources, operational reports and privileged credentials.
// Provider disclosures and dependency licences are deliberately not blocked.
const internalDirectories = new Set([
  '.git', '.github', '.codex', '.agents', 'node_modules', 'src', 'supabase',
  'server', 'api', 'scripts', 'docs', 'ml', 'tests', 'test', 'coverage',
]);
const internalFile = /^(?:\.env(?:\..*)?|AGENTS\.md|package(?:-lock)?\.json|(?:pnpm-lock|yarn\.lock|bun\.lockb?)(?:\.yaml)?|(?:vite|vitest|tsconfig|deno)(?:\.[\w-]+)*\.(?:[cm]?[jt]s|json)|vercel\.json|FORSURE-AUDIT-COMPLET\.txt|reset-cache\.html)$/i;
const internalExtension = /\.(?:sql|tsx?|jsx|py|ipynb|pem|key|log|dump|sqlite3?|bak)$/i;

function containsPrivilegedCredential(text) {
  // A PEM header literal is also used by legitimate browser parsers. Require
  // key material, including escaped line breaks in a bundled JS string.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?:\s|\\[rn])+[A-Za-z0-9+/=]{32,}/.test(text)
    || /\bsb_secret_[A-Za-z0-9_-]{16,}/.test(text)
    || /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/.test(text)) return true;
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role') return true;
    } catch { /* Not a JWT payload. Public keys and protocol strings are allowed. */ }
  }
  return false;
}

export async function verifyPublicBuild(root) {
  const violations = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      const name = relative(root, path).replaceAll('\\', '/');
      if (item.isSymbolicLink()) { violations.push(`${name}: symbolic link`); continue; }
      if (item.isDirectory()) {
        if (internalDirectories.has(item.name.toLowerCase())) violations.push(`${name}: internal directory`);
        await walk(path);
        continue;
      }
      if (!item.isFile()) continue;
      if (internalFile.test(item.name) || internalExtension.test(name)) violations.push(`${name}: internal file`);
      if (/\.map$/i.test(name)) violations.push(`${name}: public source map`);
      if (/\.(?:[cm]?js|css|html|json|webmanifest|txt|md|svg|xml|ya?ml)$/i.test(name)) {
        const text = await readFile(path, 'utf8');
        if (/sourceMappingURL\s*=/.test(text)) violations.push(`${name}: source map reference`);
        if (/data-lov-id|lovable-tagger/.test(text)) violations.push(`${name}: editor instrumentation`);
        if (/FORSURE\s*[—-]\s*DOCUMENT TECHNIQUE COMPLET|INVALID_DEVICE_IDS/.test(text)) violations.push(`${name}: internal operational artifact`);
        if (containsPrivilegedCredential(text)) violations.push(`${name}: privileged credential`);
      }
    }
  }
  await walk(root);
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const violations = await verifyPublicBuild(resolve(process.argv[2] || 'dist'));
  if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
  else console.log('[public-build] no internal artifacts, known privileged credentials, source maps or editor instrumentation');
}
