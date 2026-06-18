const ctx = self as any;

const IV_LEN = 12;
const KEY_BITS = 256;

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

ctx.onmessage = async (event: MessageEvent) => {
  const { id, file, rawKey } = event.data ?? {};
  if (!id || !file || !rawKey) return;

  try {
    const iv = randomBytes(IV_LEN);
    const key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['encrypt'],
    );
    const plaintext = await (file as Blob).arrayBuffer();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      plaintext,
    );

    const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), IV_LEN);

    ctx.postMessage({ id, ok: true, encrypted: combined.buffer }, [combined.buffer]);
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
