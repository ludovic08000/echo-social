export interface TransparencySigningKey {
  privJwk: JsonWebKey;
  pubJwk: JsonWebKey;
}

/** Une autorité de transparence doit survivre aux redéploiements, jamais être improvisée. */
export async function validateTransparencySigningKey(serialized: string | undefined): Promise<TransparencySigningKey> {
  if (!serialized?.trim()) throw new Error('KT_SIGNING_KEY_NOT_CONFIGURED');
  try {
    const parsed = JSON.parse(serialized);
    const priv = parsed?.priv;
    const pub = parsed?.pub;
    const keyPart = /^[A-Za-z0-9_-]{43}$/;
    if (!priv || !pub || priv.kty !== 'OKP' || pub.kty !== 'OKP'
      || priv.crv !== 'Ed25519' || pub.crv !== 'Ed25519'
      || typeof priv.d !== 'string' || !keyPart.test(priv.d)
      || typeof priv.x !== 'string' || !keyPart.test(priv.x)
      || typeof pub.x !== 'string' || !keyPart.test(pub.x)
      || priv.x !== pub.x || 'd' in pub) throw new Error('invalid');
    const privJwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', d: priv.d, x: priv.x };
    const pubJwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: pub.x };
    const [signing, verification] = await Promise.all([
      crypto.subtle.importKey('jwk', privJwk, 'Ed25519', false, ['sign']),
      crypto.subtle.importKey('jwk', pubJwk, 'Ed25519', false, ['verify']),
    ]);
    const challenge = new TextEncoder().encode('forsure-kt-config-validation');
    const signature = await crypto.subtle.sign('Ed25519', signing, challenge);
    if (!await crypto.subtle.verify('Ed25519', verification, signature, challenge)) throw new Error('mismatched');
    return { privJwk, pubJwk };
  } catch {
    // Ne jamais journaliser la configuration privée ni une erreur JSON qui en contient un extrait.
    throw new Error('KT_SIGNING_KEY_INVALID');
  }
}

export function assertPublishedSigningKeyMatches(published: unknown, expected: JsonWebKey): void {
  const actual = published as JsonWebKey | null;
  if (!actual || actual.kty !== 'OKP' || actual.crv !== 'Ed25519' || actual.x !== expected.x || 'd' in actual) {
    throw new Error('KT_SIGNING_KEY_MISMATCH');
  }
}
