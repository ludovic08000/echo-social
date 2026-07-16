import { readFile, writeFile } from 'node:fs/promises';

async function patchFile(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change applied to ${path}`);
  await writeFile(path, after, 'utf8');
}

function replaceOnce(source, oldText, newText, label) {
  const at = source.indexOf(oldText);
  if (at < 0) throw new Error(`Missing anchor: ${label}`);
  if (source.indexOf(oldText, at + oldText.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  return source.slice(0, at) + newText + source.slice(at + oldText.length);
}

await patchFile('src/lib/crypto/plaintextStore.ts', (source) => replaceOnce(
  source,
  `  try {\n    const map = readSessionMirror();\n    if (map[messageId]) {\n      delete map[messageId];\n      writeSessionMirror(map);\n    }\n\n    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {`,
  `  try {\n    volatileMirror.delete(messageId);\n\n    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {`,
  'removePlaintext volatile mirror',
));

await patchFile('src/hooks/useDeviceLink.ts', (source) => {
  source = replaceOnce(
    source,
    `import {\n  exportPlaintextCache,\n  importPlaintextCache,\n  type PlaintextCacheExportEntry,\n} from '@/lib/crypto/plaintextStore';\n`,
    '',
    'unused plaintext transfer imports',
  );
  source = replaceOnce(
    source,
    `  const includePlaintextCache = options.includePlaintextCache ?? true;\n  const includeLegacySessions = options.includeLegacySessions ?? false;`,
    `  const includeLegacySessions = options.includeLegacySessions ?? false;`,
    'removed plaintext transfer option',
  );
  return source;
});

await patchFile('src/lib/crypto/x3dh.ts', (source) => {
  const startMarker = 'export async function x3dhRespondForDevice';
  const endMarker = '\nexport async function finalizeDeviceX3DHInitial';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('X3DH responder boundaries missing');

  const replacement = `export async function x3dhRespondForDevice(myKeys: IdentityKeyPair, myUserId: string, myDeviceId: string, initialMessage: X3DHInitialMessage): Promise<{\n  sharedSecret: ArrayBuffer;\n  spkKeyPair: CryptoKeyPair;\n  replayReservation: import('./x3dhReplayGuard').X3DHReplayReservation;\n  usedOpkId?: number;\n}> {\n  const { reserveX3dhInitial, cancelX3dhInitial } = await import('./x3dhReplayGuard');\n  const replayReservation = await reserveX3dhInitial({\n    myUserId: \`${'${myUserId}'}::${'${myDeviceId}'}\`,\n    ik: initialMessage.ik,\n    ek: initialMessage.ek,\n    spkId: initialMessage.spkId,\n    opkId: initialMessage.opkId,\n  });\n\n  try {\n    const aliceIK = await importX25519Public(initialMessage.ik);\n    const aliceEK = await importX25519Public(initialMessage.ek);\n    const spkRecord = await loadDeviceSPKRecord(myUserId, myDeviceId, initialMessage.spkId);\n    if (!spkRecord) throw new Error(\`[X3DH-DEV] device SPK #${'${initialMessage.spkId}'} NOT FOUND for ${'${myDeviceId.slice(0, 8)}'}…\`);\n    const spkPrivate = await importKeyFromJWK(spkRecord.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], true);\n    const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);\n    const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceIK } as any, spkPrivate, 256);\n    const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, myKeys.privateKey, 256);\n    const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, spkPrivate, 256);\n    let dh4: ArrayBuffer | null = null;\n    if (initialMessage.opkId !== undefined) {\n      const opkPriv = await loadDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);\n      if (!opkPriv) throw new Error('X3DH_OPK_PRIVATE_MISSING');\n      dh4 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, opkPriv, 256);\n    }\n    const filler = new Uint8Array(32).fill(0xFF);\n    const dhConcat = dh4\n      ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)\n      : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);\n    const sharedSecret = await x3dhKDF(dhConcat);\n    return {\n      sharedSecret,\n      spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },\n      replayReservation,\n      usedOpkId: initialMessage.opkId,\n    };\n  } catch (error) {\n    await cancelX3dhInitial(replayReservation).catch(() => undefined);\n    throw error;\n  }\n}\n`;
  return source.slice(0, start) + replacement + source.slice(end);
});

await patchFile('src/lib/crypto/__tests__/signalProtocolHardening.test.ts', (source) => replaceOnce(
  source,
  `    expect(encrypted).toMatch(/^x3dh5\\.s6/);\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, encrypted!)).toBe('bonjour');\n\n    const parts = encrypted!.split('.');\n    parts[4] = String(Number(parts[4]) + 1); // PN is header metadata, not ciphertext.\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, parts.join('.'))).toBeNull();`,
  `    expect(encrypted).toMatch(/^x3dh5\\.s6/);\n\n    const parts = encrypted!.split('.');\n    parts[4] = String(Number(parts[4]) + 1); // PN is header metadata, not ciphertext.\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, parts.join('.'))).toBeNull();\n\n    // Authentication failure must not advance the receiving ratchet state.\n    expect(await ratchetDecryptWithSession(BOB, BOB_DEVICE, ALICE, ALICE_DEVICE, encrypted!)).toBe('bonjour');`,
  'tampered header test ordering',
));

console.log('Signal hardening follow-up applied.');
