// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { verifyPublicBuild } from '../../scripts/verify-public-build.mjs';

it('rejects source maps and editor metadata while preserving licenses and honest provider disclosures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forsure-build-test-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), 'ForSure hébergé par Lovable Cloud');
    await writeFile(join(root, 'assets', 'app.js'), '/*! dependency copyright and license */ console.log("ForSure");');
    expect(await verifyPublicBuild(root)).toEqual([]);
    await writeFile(join(root, 'assets', 'app.js.map'), '{}');
    await writeFile(join(root, 'assets', 'debug.js'), '//# sourceMappingURL=data:application/json;base64,e30=\nconst x="data-lov-id";');
    const violations = await verifyPublicBuild(root);
    expect(violations).toEqual(expect.arrayContaining([
      'assets/app.js.map: public source map', 'assets/debug.js: source map reference', 'assets/debug.js: editor instrumentation',
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects repository and operational files even in a nested output folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forsure-build-internal-'));
  try {
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'assets'));
    for (const name of ['.env.production', 'AGENTS.md', 'package.json', 'vite.config.ts', 'FORSURE-AUDIT-COMPLET.txt', 'reset-cache.html']) {
      await writeFile(join(root, name), 'fixture');
    }
    await writeFile(join(root, 'assets', 'migration.sql'), 'select 1');
    await writeFile(join(root, 'docs', 'renamed.txt'), 'FORSURE — DOCUMENT TECHNIQUE COMPLET');
    const violations = await verifyPublicBuild(root);
    expect(violations).toEqual(expect.arrayContaining([
      '.env.production: internal file', 'AGENTS.md: internal file', 'package.json: internal file',
      'vite.config.ts: internal file', 'FORSURE-AUDIT-COMPLET.txt: internal file', 'reset-cache.html: internal file',
      'assets/migration.sql: internal file', 'docs: internal directory', 'docs/renamed.txt: internal operational artifact',
    ]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects privileged credentials without printing them, while accepting public app keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forsure-build-credentials-'));
  const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.syntheticSignature`;
  try {
    await writeFile(join(root, 'app.js'), `const key = "${jwt('anon')}"; const publishable = "sb_publishable_synthetic"; const pemHeader = "-----BEGIN PRIVATE KEY-----";`);
    expect(await verifyPublicBuild(root)).toEqual([]);
    const fakePem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(48)}\n-----END PRIVATE KEY-----`;
    for (const secret of [jwt('service_role'), 'sb_secret_synthetic_fixture_only', 'sk_test_syntheticfixtureonly123456789', fakePem, JSON.stringify(fakePem)]) {
      await writeFile(join(root, 'app.js'), `const key = "${secret}";`);
      expect(await verifyPublicBuild(root)).toEqual(['app.js: privileged credential']);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps historical files recoverable outside public without preserving the dangerous public maintenance page', async () => {
  for (const name of ['FORSURE-AUDIT-COMPLET.txt', 'reset-cache.html']) {
    await expect(access(join('public', name))).rejects.toThrow();
  }
  expect(await readFile('docs/security/archives/FORSURE-AUDIT-COMPLET-2026-03-08.txt', 'utf8')).toContain('DOCUMENT TECHNIQUE COMPLET');
  expect(await readFile('docs/security/archives/reset-cache-legacy.html.txt', 'utf8')).toContain('ARCHIVE NON EXÉCUTABLE');
  expect(await verifyPublicBuild('public')).toEqual([]);
});

it('uses opaque emitted asset names but preserves PWA cache identities and crypto formats', async () => {
  const config = await readFile('vite.config.ts', 'utf8');
  expect(config).toContain('assets/resource-[hash][extname]');
  expect(config).toContain('sourcemap: false');
  expect(config).toContain('cacheId: "forsure-aegis-v1"');
  expect(config).toContain('cacheName: "documents-aegis-v1"');
  expect(config).toContain('mode === "development" && componentTagger()');
});
