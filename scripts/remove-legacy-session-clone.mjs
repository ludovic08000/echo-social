import { readFile, writeFile } from 'node:fs/promises';

const path = 'src/hooks/useDeviceLink.ts';
let source = await readFile(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  const index = source.indexOf(oldText);
  if (index < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(oldText, index + oldText.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  source = source.slice(0, index) + newText + source.slice(index + oldText.length);
}

replaceOnce(
  `import { runTx, runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';`,
  `import { runTx, reqToPromise } from '@/lib/crypto/indexedDbTx';`,
  'indexedDbTx imports',
);

replaceOnce(
  `interface CollectOptions {\n  includeLegacySessions?: boolean;\n}\n\n`,
  '',
  'CollectOptions',
);

const sideStoreStart = source.indexOf(`async function readSideStore(`);
const collectDoc = source.indexOf(`/**\n * Collect account-scoped E2EE material.`, sideStoreStart);
if (sideStoreStart < 0 || collectDoc < 0) throw new Error('side-store helper boundaries missing');
source = source.slice(0, sideStoreStart) + source.slice(collectDoc);

replaceOnce(
  `async function collectLocalKeys(userId: string, options: CollectOptions = {}): Promise<string> {\n  const includeLegacySessions = options.includeLegacySessions ?? false;`,
  `async function collectLocalKeys(userId: string): Promise<string> {`,
  'collectLocalKeys signature',
);

replaceOnce(
  `      if (!includeLegacySessions && storeName !== IDENTITY_STORE) continue;`,
  `      if (storeName !== IDENTITY_STORE) continue;`,
  'identity-only collection',
);

const legacyExport = `\n  // Only the explicitly legacy PIN payload keeps old ratchet state.\n  if (includeLegacySessions) {\n    const ratchets = await readSideStore('ratchet', 'ratchet-states');\n    if (ratchets.length > 0) data['ratchet:states'] = ratchets;\n  }\n`;
replaceOnce(legacyExport, '', 'legacy ratchet export');

replaceOnce(
  `    mode: includeLegacySessions ? 'legacy' : 'sesame-fresh-device',`,
  `    mode: 'sesame-fresh-device',`,
  'fresh-device metadata',
);

replaceOnce(
  `  const restoreLegacyDeviceState = data?._meta?.mode === 'legacy';\n\n`,
  '',
  'legacy restore flag',
);

replaceOnce(
  `    if (!restoreLegacyDeviceState && storeName !== IDENTITY_STORE) continue;`,
  `    if (storeName !== IDENTITY_STORE) continue;`,
  'identity-only restore',
);

const legacyRestore = `\n  if (restoreLegacyDeviceState && Array.isArray(data['ratchet:states'])) {\n    await writeSideStore('ratchet', 'ratchet-states', data['ratchet:states']);\n  }\n`;
replaceOnce(legacyRestore, '', 'legacy ratchet restore');

replaceOnce(
  `      const keysJson = await collectLocalKeys(user.id, { includeLegacySessions: true });`,
  `      const keysJson = await collectLocalKeys(user.id);`,
  'legacy PIN source flow',
);

await writeFile(path, source, 'utf8');

const auditPath = 'docs/SIGNAL_PROTOCOL_AUDIT.md';
let audit = await readFile(auditPath, 'utf8');
const auditNeedle = `- Linked-device transfer no longer exports a decrypted plaintext cache.\n`;
const auditReplacement = `${auditNeedle}- Legacy PIN linking no longer clones Double Ratchet sessions; every physical device establishes fresh sessions.\n`;
if (!audit.includes(auditReplacement)) {
  if (!audit.includes(auditNeedle)) throw new Error('audit note anchor missing');
  audit = audit.replace(auditNeedle, auditReplacement);
}
await writeFile(auditPath, audit, 'utf8');

console.log('Legacy linked-device ratchet cloning removed.');
