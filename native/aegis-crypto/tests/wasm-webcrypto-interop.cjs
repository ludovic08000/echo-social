const wasm = require('../target/wasm-node/aegis_crypto.cjs');
const webcrypto = require('node:crypto').webcrypto;

function unpack(bytes, count) {
  let offset = 0;
  const parts = [];
  for (let index = 0; index < count; index += 1) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    parts.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('PACK_INVALID');
  return parts;
}

async function main() {
  const chainKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const aad = new TextEncoder().encode('FORSURE-AEGIS-DEVICE-v1|interop');
  const plaintext = new TextEncoder().encode('Windows WASM vers iOS WebCrypto');
  const [nextChain, iv, ciphertext] = unpack(
    wasm.aegis_wasm_ratchet_encrypt(chainKey, aad, plaintext), 3,
  );
  const hmacKey = await webcrypto.subtle.importKey(
    'raw', chainKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const messageKey = new Uint8Array(await webcrypto.subtle.sign('HMAC', hmacKey, Uint8Array.of(1)));
  const expectedNext = new Uint8Array(await webcrypto.subtle.sign('HMAC', hmacKey, Uint8Array.of(2)));
  if (!Buffer.from(nextChain).equals(Buffer.from(expectedNext))) throw new Error('CHAIN_MISMATCH');
  const aesKey = await webcrypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const clear = new Uint8Array(await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, aesKey, ciphertext,
  ));
  if (!Buffer.from(clear).equals(Buffer.from(plaintext))) throw new Error('WASM_TO_WEBCRYPTO_FAILED');

  const webIv = Uint8Array.from({ length: 12 }, (_, index) => 20 + index);
  const webCiphertext = new Uint8Array(await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: webIv, additionalData: aad, tagLength: 128 }, aesKey, plaintext,
  ));
  const [wasmNext, wasmClear] = unpack(
    wasm.aegis_wasm_ratchet_decrypt(chainKey, aad, webIv, webCiphertext), 2,
  );
  if (!Buffer.from(wasmNext).equals(Buffer.from(expectedNext))) throw new Error('NEXT_CHAIN_MISMATCH');
  if (!Buffer.from(wasmClear).equals(Buffer.from(plaintext))) throw new Error('WEBCRYPTO_TO_WASM_FAILED');
  process.stdout.write('WASM/WebCrypto ratchet interop: OK\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
