/** Execute the shipped binary, without mocking the crypto engine or its clock. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = resolve(process.argv[2] ?? 'src/lib/crypto/wasm/generated');
const wasm = await import(pathToFileURL(resolve(directory, 'aegis_crypto.js')));
const watchdog = setTimeout(() => { console.error('Libsignal WASM operation stalled'); process.exit(1); }, 30000);
await wasm.default({ module_or_path: await readFile(resolve(directory, 'aegis_crypto_bg.wasm')) });
assert.equal(wasm.aegis_wasm_abi_version(), 1);
function unpack(bytes, count) {
  const parts = []; let offset = 0;
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 4 <= bytes.length);
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    offset += 4; assert.ok(length > 0 && offset + length <= bytes.length);
    parts.push(bytes.slice(offset, offset + length)); offset += length;
  }
  assert.equal(offset, bytes.length); return parts;
}
try {
  for (const [sender, recipient] of [['alice','bob'], ['bob','alice'], ['alice','carol'], ['carol','alice'], ['bob','carol'], ['carol','bob']]) {
    let a = wasm.aegis_wasm_store_create(101);
    let b = wasm.aegis_wasm_store_create(202);
    await assert.rejects(
      wasm.aegis_wasm_message_encrypt(a, sender, 1, recipient, 1, Uint8Array.of(1)),
      /session with .+ not found:/,
    );
    const [stored, bundle] = unpack(await wasm.aegis_wasm_bundle_create(b, 1, 11, 12, 13), 2);
    b = stored;
    a = await wasm.aegis_wasm_session_establish(a, sender, 1, recipient, 1, bundle);
    for (let i = 0; i < 3; i++) {
      const text = new TextEncoder().encode(`${sender} → ${recipient} : bonjour 👋 ${i}`);
      const [nextA, type, ciphertext] = unpack(await wasm.aegis_wasm_message_encrypt(a, sender, 1, recipient, 1, text), 3);
      a = nextA.slice();
      const [nextB, clear] = unpack(await wasm.aegis_wasm_message_decrypt(b.slice(), recipient, 1, sender, 1, type[0], ciphertext), 2);
      b = nextB; assert.deepEqual(clear, text);
      const [replyB, replyType, replyCipher] = unpack(await wasm.aegis_wasm_message_encrypt(b, recipient, 1, sender, 1, text), 3);
      b = replyB;
      const [replyA, replyClear] = unpack(await wasm.aegis_wasm_message_decrypt(a, sender, 1, recipient, 1, replyType[0], replyCipher), 2);
      a = replyA; assert.deepEqual(replyClear, text);
    }
    console.log(`PASS ${sender} ↔ ${recipient}: bundle, session, 3 round trips, serialized stores`);
  }
  console.log('Real WASM checks passed; native devices and production delivery are separate gates.');
} finally { clearTimeout(watchdog); }
