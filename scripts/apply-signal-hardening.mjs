import { readFile, writeFile, mkdir } from 'node:fs/promises';

const ROOT = process.cwd();

async function read(path) {
  return readFile(`${ROOT}/${path}`, 'utf8');
}

async function write(path, content) {
  await mkdir(`${ROOT}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
  await writeFile(`${ROOT}/${path}`, content, 'utf8');
}

function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (content.indexOf(search, index + 1) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function replaceRegexOnce(content, regex, replacement, label) {
  const matches = [...content.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected one regex match for ${label}, got ${matches.length}`);
  return content.replace(regex, replacement);
}

function extractTemplate(source, name) {
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing template ${name}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf('`;', bodyStart);
  if (end < 0) throw new Error(`Unterminated template ${name}`);
  return source.slice(bodyStart, end);
}

function removeBetween(content, startMarker, endMarker, label) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) throw new Error(`Missing section ${label}`);
  return content.slice(0, start) + content.slice(end);
}

async function patchX3dh(viteSource) {
  const path = 'src/lib/crypto/x3dh.ts';
  let source = await read(path);
  source = replaceOnce(source, extractTemplate(viteSource, 'signatureAnchor'), extractTemplate(viteSource, 'signatureTwoPhase'), 'x3dh two-phase signature');
  source = replaceOnce(
    source,
    `    await deleteDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);`,
    `    // OPK deletion is deferred until the bootstrap ciphertext has been\n    // authenticated and the responder ratchet has been persisted.`,
    'defer OPK deletion',
  );
  source = replaceOnce(
    source,
    `  return { sharedSecret, spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate } };\n}\n\nexport function isPQXDHAvailable(): boolean { return false; }`,
    `  return {\n    sharedSecret,\n    spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },\n    replayReservation,\n    usedOpkId: initialMessage.opkId,\n  };\n}\n\nexport async function finalizeDeviceX3DHInitial(args: {\n  userId: string;\n  deviceId: string;\n  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation;\n  usedOpkId?: number;\n}): Promise<void> {\n  const { finalizeX3dhInitial } = await import('./x3dhReplayGuard');\n  await finalizeX3dhInitial(args.replayReservation);\n  if (args.usedOpkId !== undefined) {\n    await deleteDeviceOPKPrivate(args.userId, args.deviceId, args.usedOpkId);\n  }\n}\n\nexport async function cancelDeviceX3DHInitial(\n  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation,\n): Promise<void> {\n  const { cancelX3dhInitial } = await import('./x3dhReplayGuard');\n  await cancelX3dhInitial(replayReservation);\n}\n\nexport function isPQXDHAvailable(): boolean { return false; }`,
    'x3dh finalize API',
  );
  await write(path, source);
}

async function patchDeviceRatchet(viteSource) {
  const path = 'src/lib/crypto/deviceRatchet.ts';
  let source = await read(path);
  source = replaceOnce(source, extractTemplate(viteSource, 'saveAnchor'), extractTemplate(viteSource, 'saveFailClosed'), 'fail-closed device session persistence');
  source = replaceOnce(
    source,
    `const AD_PREFIX_DEV_V5 = 'FORSURE-DEV-AD-v5|';`,
    `const AD_PREFIX_DEV_V5 = 'FORSURE-DEV-AD-v5|';\nconst AD_HEADER_PREFIX_DEV_V6 = 'FORSURE-DEV-HDR-v6|';\nconst HEADER_BOUND_SESSION_PREFIX = 's6';`,
    'device header constants',
  );
  source = replaceOnce(
    source,
    `function parseCompositeKey(key: string): { myUserId: string; myDeviceId: string; peerUserId: string; peerDeviceId: string } | null {`,
    `function isHeaderBoundSession(sessionId: string): boolean {\n  return sessionId.startsWith(HEADER_BOUND_SESSION_PREFIX);\n}\n\nfunction buildDevAADWithHeader(\n  myUserId: string,\n  myDeviceId: string,\n  peerUserId: string,\n  peerDeviceId: string,\n  sessionId: string,\n  header: { dh: string; pn: number; n: number },\n): Uint8Array {\n  const identityAd = buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, sessionId);\n  const headerAd = new hardGlobals.TextEncoder().encode(\n    \`${'${AD_HEADER_PREFIX_DEV_V6}'}${'${header.dh}'}|${'${header.pn}'}|${'${header.n}'}\`,\n  );\n  const out = new Uint8Array(identityAd.byteLength + headerAd.byteLength);\n  out.set(identityAd, 0);\n  out.set(headerAd, identityAd.byteLength);\n  return out;\n}\n\nfunction parseCompositeKey(key: string): { myUserId: string; myDeviceId: string; peerUserId: string; peerDeviceId: string } | null {`,
    'header-bound AAD helper',
  );
  source = replaceOnce(
    source,
    `    sessionId ?? bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, '').slice(0, 12);`,
    `    sessionId ?? \`${'${HEADER_BOUND_SESSION_PREFIX}'}${'${bufferToBase64(randomBytes(8).buffer as ArrayBuffer).replace(/[+/=]/g, \'\').slice(0, 10)}'}\`;`,
    'new session marker',
  );
  source = replaceOnce(
    source,
    `  const { ck, mk } = await kdfCK(session.ckSendB64);\n  const aes = await importMessageKey(mk);\n  const iv = randomBytes(12);\n  const aad = buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId);\n  const ct = await hardCrypto.encrypt(\n    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> },\n    aes,\n    new hardGlobals.TextEncoder().encode(plaintext),\n  );\n\n  const Ns = session.Ns;`,
    `  const { ck, mk } = await kdfCK(session.ckSendB64);\n  const aes = await importMessageKey(mk);\n  const iv = randomBytes(12);\n  const Ns = session.Ns;\n  const header = { dh: session.dhsPubB64, pn: session.PN, n: Ns };\n  const aad = isHeaderBoundSession(session.sessionId)\n    ? buildDevAADWithHeader(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId, header)\n    : buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, session.sessionId);\n  const ct = await hardCrypto.encrypt(\n    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128, additionalData: aad as Uint8Array<ArrayBuffer> },\n    aes,\n    new hardGlobals.TextEncoder().encode(plaintext),\n  );`,
    'encrypt full header AAD',
  );
  source = replaceOnce(
    source,
    `  const peer = parseCompositeKey(found.key);\n  const isV5 = prefix === RATCHET_PREFIX_V5;\n  if (isV5 && !peer) return null;\n  const aad = isV5 && peer\n    ? buildDevAAD(peer.myUserId, peer.myDeviceId, peer.peerUserId, peer.peerDeviceId, sessionId)\n    : null;\n  return decryptV4WithStored(found.key, found.session, parts, aad, isV5, peer ?? undefined);`,
    `  const peer = parseCompositeKey(found.key);\n  const isV5 = prefix === RATCHET_PREFIX_V5;\n  if (isV5 && !peer) return null;\n  const headerBound = isV5 && isHeaderBoundSession(sessionId);\n  const header = { dh: parts[1], n: Number(parts[2]), pn: Number(parts[3]) };\n  if (headerBound && (!Number.isSafeInteger(header.n) || !Number.isSafeInteger(header.pn))) return null;\n  const aad = isV5 && peer\n    ? (headerBound\n      ? buildDevAADWithHeader(peer.myUserId, peer.myDeviceId, peer.peerUserId, peer.peerDeviceId, sessionId, header)\n      : buildDevAAD(peer.myUserId, peer.myDeviceId, peer.peerUserId, peer.peerDeviceId, sessionId))\n    : null;\n  return decryptV4WithStored(found.key, found.session, parts, aad, isV5, peer ?? undefined);`,
    'decrypt lookup full header AAD',
  );
  source = replaceOnce(
    source,
    `  const aad = isV5\n    ? buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, parts[0])\n    : null;\n  return decryptV4WithStored(key, session, parts, aad, isV5, { peerUserId, peerDeviceId });`,
    `  const headerBound = isV5 && isHeaderBoundSession(parts[0]);\n  const header = { dh: parts[1], n: Number(parts[2]), pn: Number(parts[3]) };\n  if (headerBound && (!Number.isSafeInteger(header.n) || !Number.isSafeInteger(header.pn))) return null;\n  const aad = isV5\n    ? (headerBound\n      ? buildDevAADWithHeader(myUserId, myDeviceId, peerUserId, peerDeviceId, parts[0], header)\n      : buildDevAAD(myUserId, myDeviceId, peerUserId, peerDeviceId, parts[0]))\n    : null;\n  return decryptV4WithStored(key, session, parts, aad, isV5, { peerUserId, peerDeviceId });`,
    'decrypt explicit session full header AAD',
  );
  await write(path, source);
}

async function patchFanout(viteSource) {
  const path = 'src/lib/messaging/multiDeviceFanout.ts';
  let source = await read(path);
  source = replaceOnce(
    source,
    `  x3dhRespondForDevice,\n} from '@/lib/crypto/x3dh';`,
    `  x3dhRespondForDevice,\n  finalizeDeviceX3DHInitial,\n  cancelDeviceX3DHInitial,\n} from '@/lib/crypto/x3dh';`,
    'fanout x3dh lifecycle imports',
  );
  source = replaceOnce(
    source,
    `    try {\n      await establishDeviceSession(\n        senderUserId, senderDeviceId,\n        recipientUserId, recipientDeviceId,\n        result.sharedSecret,\n        undefined,\n        {\n          peerInitialDhPubB64: bundle.signedPrekey,\n          isInitiator: true,\n          peerSpkId: bundle.signedPrekeyId,\n        },\n      );\n    } catch {}\n\n    return parts.join('.');`,
    `    await establishDeviceSession(\n      senderUserId, senderDeviceId,\n      recipientUserId, recipientDeviceId,\n      result.sharedSecret,\n      undefined,\n      {\n        peerInitialDhPubB64: bundle.signedPrekey,\n        isInitiator: true,\n        peerSpkId: bundle.signedPrekeyId,\n      },\n    );\n\n    return parts.join('.');`,
    'initiator session persistence',
  );
  source = replaceOnce(source, extractTemplate(viteSource, 'unwrapAnchor'), extractTemplate(viteSource, 'unwrapTwoPhase'), 'fanout authenticated x3dh finalize');
  await write(path, source);
}

async function patchPlaintextStore() {
  const path = 'src/lib/crypto/plaintextStore.ts';
  let source = await read(path);
  source = replaceRegexOnce(
    source,
    /const SESSION_MIRROR_KEY = 'forsure-pt-mirror-v1';[\s\S]*?function mirrorGet\(id: string\): string \| null \{[\s\S]*?\n\}/,
    `const volatileMirror = new Map<string, string>();\n\nfunction mirrorSet(id: string, plaintext: string) {\n  volatileMirror.set(id, plaintext);\n}\n\nfunction mirrorGet(id: string): string | null {\n  return volatileMirror.get(id) ?? null;\n}`,
    'remove persistent plaintext mirror',
  );
  source = replaceOnce(
    source,
    `async function saveEntry(id: string, plaintext: string): Promise<void> {`,
    `function entryAAD(id: string): Uint8Array {\n  return new TextEncoder().encode(\`sesame-plaintext-cache-v2|${'${id}'}\`);\n}\n\nasync function saveEntry(id: string, plaintext: string): Promise<void> {`,
    'plaintext cache AAD helper',
  );
  source = replaceOnce(
    source,
    `    { name: 'AES-GCM', iv },`,
    `    { name: 'AES-GCM', iv, additionalData: entryAAD(id) },`,
    'plaintext cache encrypt AAD',
  );
  source = replaceOnce(
    source,
    `  try {\n    const key = await getOrCreateDeviceKey();\n    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.ct);\n    return new TextDecoder().decode(pt);\n  } catch {\n    return null;\n  }`,
    `  const key = await getOrCreateDeviceKey();\n  try {\n    const pt = await crypto.subtle.decrypt(\n      { name: 'AES-GCM', iv: entry.iv, additionalData: entryAAD(id) },\n      key,\n      entry.ct,\n    );\n    return new TextDecoder().decode(pt);\n  } catch {\n    // One-time compatibility read for pre-v2 cache entries. Re-encrypt with\n    // ID-bound AAD immediately so ciphertext cannot be swapped between rows.\n    try {\n      const legacy = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.ct);\n      const plaintext = new TextDecoder().decode(legacy);\n      await saveEntry(id, plaintext);\n      return plaintext;\n    } catch {\n      return null;\n    }\n  }`,
    'plaintext cache decrypt AAD migration',
  );
  source = replaceOnce(
    source,
    `  try {\n    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_MIRROR_KEY);\n  } catch {}\n\n  try {`,
    `  volatileMirror.clear();\n\n  try {`,
    'wipe volatile plaintext mirror',
  );
  await write(path, source);
}

async function patchDeviceLink() {
  const path = 'src/hooks/useDeviceLink.ts';
  let source = await read(path);
  source = replaceOnce(
    source,
    `import {\n  exportPlaintextCache,\n  importPlaintextCache,\n  type PlaintextCacheExportEntry,\n} from '@/lib/crypto/plaintextStore';\n`,
    '',
    'remove plaintext transfer imports',
  );
  source = replaceOnce(
    source,
    `interface CollectOptions {\n  includePlaintextCache?: boolean;\n  includeLegacySessions?: boolean;\n}`,
    `interface CollectOptions {\n  includeLegacySessions?: boolean;\n}`,
    'device link options',
  );
  source = replaceOnce(
    source,
    `  const includePlaintextCache = options.includePlaintextCache ?? true;\n  const includeLegacySessions = options.includeLegacySessions ?? false;`,
    `  const includeLegacySessions = options.includeLegacySessions ?? false;`,
    'device link collect flags',
  );
  source = replaceRegexOnce(
    source,
    /\n  if \(includePlaintextCache\) \{[\s\S]*?\n  \}\n\n  try \{/,
    `\n\n  try {`,
    'remove plaintext cache export',
  );
  source = replaceRegexOnce(
    source,
    /\n  if \(Array\.isArray\(data\['plaintext:cache'\]\)\) \{[\s\S]*?\n  \}\n\n  if \(typeof data\.fingerprints/,
    `\n\n  if (typeof data.fingerprints`,
    'remove plaintext cache import',
  );
  source = source.replace(`collectLocalKeys(user.id, { includePlaintextCache: false })`, `collectLocalKeys(user.id)`);
  await write(path, source);
}

async function patchDeviceRegistry() {
  const path = 'src/e2ee-session/deviceRegistry.ts';
  let source = await read(path);
  source = source.replace(`import { supabase } from '@/integrations/supabase/client';\n`, '');
  source = replaceRegexOnce(
    source,
    /\n  \/\/ 2\) Legacy fallback for users who haven't published any signature yet\.[\s\S]*?\n  \} catch \{\n    return \[\];\n  \}\n\}/,
    `\n  // Signal-style trust is fail-closed: an unsigned server device list is not\n  // sufficient authority to add a recipient device. Registration must publish\n  // the canonical primary root and signed companions before messaging starts.\n  if (typeof console !== 'undefined') {\n    console.warn('[A1] no canonical signed device list; refusing unsigned device routing', { userId });\n  }\n  return [];\n}`,
    'remove unsigned device fallback',
  );
  await write(path, source);
}

async function patchViteConfig(viteSource) {
  let source = viteSource;
  source = removeBetween(
    source,
    `      if (cleanId.endsWith("/src/lib/crypto/deviceRatchet.ts")) {`,
    `      if (cleanId.endsWith("/src/lib/crypto/x3dh.ts")) {`,
    'deviceRatchet build transform',
  );
  source = removeBetween(
    source,
    `      if (cleanId.endsWith("/src/lib/crypto/x3dh.ts")) {`,
    `      if (cleanId.endsWith("/src/lib/messaging/multiDeviceFanout.ts")) {`,
    'x3dh build transform',
  );
  await write('vite.config.ts', source);
}

async function addTests() {
  const test = `import { beforeEach, describe, expect, it } from 'vitest';\nimport 'fake-indexeddb/auto';\nimport {\n  establishDeviceSession,\n  ratchetDecryptWithSession,\n  ratchetEncrypt,\n  clearAllDeviceSessions,\n} from '../deviceRatchet';\nimport { bufferToBase64 } from '../utils';\n\nconst ALICE = '11111111-1111-4111-8111-111111111111';\nconst BOB = '22222222-2222-4222-8222-222222222222';\nconst ALICE_DEVICE = 'alice-device-001';\nconst BOB_DEVICE = 'bob-device-001';\n\nasync function rawPublic(key: CryptoKey): Promise<string> {\n  return bufferToBase64(await crypto.subtle.exportKey('raw', key) as ArrayBuffer);\n}\n\ndescribe('Signal protocol hardening', () => {\n  beforeEach(async () => {\n    await clearAllDeviceSessions();\n  });\n\n  it('authenticates the complete device ratchet header for new sessions', async () => {\n    const sharedSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;\n    const bobInitial = await crypto.subtle.generateKey(\n      { name: 'X25519' } as any,\n      true,\n      ['deriveBits'],\n    ) as CryptoKeyPair;\n    const bobPrivateJwk = await crypto.subtle.exportKey('jwk', bobInitial.privateKey);\n    const bobPublic = await rawPublic(bobInitial.publicKey);\n\n    await establishDeviceSession(ALICE, ALICE_DEVICE, BOB, BOB_DEVICE, sharedSecret, undefined, {\n      isInitiator: true,\n      peerInitialDhPubB64: bobPublic,\n    });\n    await establishDeviceSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, sharedSecret, undefined, {\n      isInitiator: false,\n      selfInitialDhPrivJwk: bobPrivateJwk,\n      selfInitialDhPubB64: bobPublic,\n    });\n\n    const encrypted = await ratchetEncrypt(ALICE, ALICE_DEVICE, BOB, BOB_DEVICE, 'bonjour');\n    expect(encrypted).toMatch(/^x3dh5\\.s6/);\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, encrypted!)).toBe('bonjour');\n\n    const parts = encrypted!.split('.');\n    parts[4] = String(Number(parts[4]) + 1); // PN is header metadata, not ciphertext.\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, parts.join('.'))).toBeNull();\n  });\n});\n`;
  await write('src/lib/crypto/__tests__/signalProtocolHardening.test.ts', test);
}

async function addAuditDoc() {
  const doc = `# Audit Signal / Sesame — hardening direct des sources\n\nSesame is not wire-compatible with the official Signal clients and does not claim certification by Signal. This patch aligns the custom WebCrypto/Supabase implementation with selected X3DH and Double Ratchet security invariants.\n\n## Corrected invariants\n\n- X3DH one-time prekeys are finalized only after AEAD authentication and durable ratchet persistence.\n- New device-pair sessions authenticate the complete Double Ratchet header (DH public key, previous-chain count and message number). Existing v5 sessions remain readable until they naturally re-bootstrap.\n- Ratchet state persistence is fail-closed; a message is not emitted after an unpersisted chain-key advance.\n- The IndexedDB plaintext cache binds ciphertext to its row identifier with AES-GCM AAD. Its hot mirror is RAM-only, never sessionStorage.\n- Linked-device transfer no longer exports a decrypted plaintext cache.\n- Unsigned raw device lists are no longer accepted as a recipient-routing authority.\n- X3DH and device-ratchet security changes now live in checked-in source rather than Vite string transforms.\n\n## Deliberate architecture differences\n\n- React, Supabase and IndexedDB replace Signal Desktop's Electron/SQL/service stack.\n- Separate X25519 transport and Ed25519 signing keys are used and pinned through Sesame's canonical identity root.\n- Encrypted same-device session durability in Supabase remains a Sesame feature; the server receives only client-side ciphertext.\n`;
  await write('docs/SIGNAL_PROTOCOL_AUDIT.md', doc);
}

async function main() {
  const viteSource = await read('vite.config.ts');
  await patchX3dh(viteSource);
  await patchDeviceRatchet(viteSource);
  await patchFanout(viteSource);
  await patchPlaintextStore();
  await patchDeviceLink();
  await patchDeviceRegistry();
  await patchViteConfig(viteSource);
  await addTests();
  await addAuditDoc();
  console.log('Signal protocol hardening applied.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
