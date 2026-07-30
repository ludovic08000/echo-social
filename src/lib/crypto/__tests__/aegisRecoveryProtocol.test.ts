import { describe, expect, it } from 'vitest';
import {
  AEGIS_RECOVERY_PROTOCOL,
  AEGIS_RECOVERY_VERSION,
  decideRecoveryInstall,
  generateAegisRecoveryKey,
  nextRecoveryGeneration,
  openAegisRecoveryVault,
  sealAegisRecoveryVault,
  type AegisRecoveryVaultPayload,
} from '../aegisRecoveryProtocol';

const userId = '11111111-1111-4111-8111-111111111111';

function payload(generation = 1): AegisRecoveryVaultPayload {
  return {
    protocol: AEGIS_RECOVERY_PROTOCOL,
    version: AEGIS_RECOVERY_VERSION,
    userId,
    generation,
    createdAt: '2026-07-30T12:00:00.000Z',
    identity: {
      publicKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      privateKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', d: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
      signingPublicKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
      signingPrivateKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', d: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' },
      createdAt: 1_700_000_000_000,
      fingerprint: 'AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99 AA BB CC DD',
    },
  };
}

describe('Aegis recovery vault protocol', () => {
  it('round-trips one account identity with bound metadata', async () => {
    const recoveryKey = generateAegisRecoveryKey();
    const sealed = await sealAegisRecoveryVault(payload(), recoveryKey);
    const opened = await openAegisRecoveryVault({ envelope: sealed, recoveryKey, userId });
    expect(opened).toEqual(payload());
  });

  it('rejects a wrong recovery key', async () => {
    const sealed = await sealAegisRecoveryVault(payload(), generateAegisRecoveryKey());
    await expect(openAegisRecoveryVault({
      envelope: sealed,
      recoveryKey: generateAegisRecoveryKey(),
      userId,
    })).rejects.toBeTruthy();
  });

  it('rejects envelope metadata tampering', async () => {
    const recoveryKey = generateAegisRecoveryKey();
    const sealed = await sealAegisRecoveryVault(payload(2), recoveryKey);
    await expect(openAegisRecoveryVault({
      envelope: { ...sealed, generation: 3 },
      recoveryKey,
      userId,
    })).rejects.toBeTruthy();
  });

  it('never overwrites a different local or server identity', () => {
    expect(decideRecoveryInstall({ vaultFingerprint: 'A' })).toBe('install');
    expect(decideRecoveryInstall({ vaultFingerprint: 'A', localFingerprint: 'A' })).toBe('already_present');
    expect(decideRecoveryInstall({ vaultFingerprint: 'A', localFingerprint: 'B' })).toBe('conflict');
    expect(decideRecoveryInstall({ vaultFingerprint: 'A', serverFingerprint: 'B' })).toBe('conflict');
  });

  it('requires strictly increasing generations', () => {
    expect(nextRecoveryGeneration(null)).toBe(1);
    expect(nextRecoveryGeneration(1)).toBe(2);
    expect(() => nextRecoveryGeneration(0)).toThrow('INVALID_RECOVERY_GENERATION');
  });
});
