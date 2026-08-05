import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('ios/App/App/AegisKeychainPlugin.swift', 'utf8');

describe('native iOS Aegis Continuity Enclave contract', () => {
  it('binds the root anchor to the Secure Enclave and physical device', () => {
    expect(source).toContain('kSecAttrTokenIDSecureEnclave');
    expect(source).toContain('kSecAttrKeyTypeECSECPrimeRandom');
    expect(source).toContain('kSecAttrKeySizeInBits: 256');
    expect(source).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(source).toContain('.privateKeyUsage');
    expect(source).toContain('kSecAttrIsPermanent');
  });

  it('seals exact Ed25519/X25519 records with authenticated P-256 ECIES', () => {
    expect(source).toContain('eciesEncryptionCofactorX963SHA256AESGCM');
    expect(source).toContain('P256-ECIES-X963-SHA256-AESGCM');
    expect(source).toContain('AEGIS-ACE1:');
    expect(source).toContain('SecKeyCreateEncryptedData');
    expect(source).toContain('SecKeyCreateDecryptedData');
    expect(source).toContain('anchorFingerprint');
  });

  it('never silently rotates an anchor while sealed device keys survive', () => {
    expect(source).toContain('containsAnySealedRecord');
    expect(source).toContain('E2EE_ENCLAVE_ANCHOR_MISSING');
    expect(source).toContain('existingRecord?.starts(with: sealedPrefix)');
  });

  it('migrates the old native record without changing its plaintext value', () => {
    expect(source).toContain('One-time migration');
    expect(source).toContain('self.unseal(record: sealed, account: account) == value');
    expect(source).toContain('E2EE_ENCLAVE_MIGRATION_READBACK_FAILED');
  });

  it('keeps Preferences, iCloud sync, and logs outside the trust root', () => {
    expect(source).toContain('kSecClassGenericPassword');
    expect(source).toContain('AegisKeychain');
    expect(source).not.toContain('UserDefaults');
    expect(source).not.toContain('kSecAttrSynchronizable');
    expect(source).not.toMatch(/(^|\n)\s*(?:Swift\.)?print\s*\(/);
    expect(source).not.toContain('NSLog');
  });

  it('does not tie unattended messaging continuity to mutable biometrics', () => {
    expect(source).not.toContain('biometryCurrentSet');
    expect(source).not.toContain('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly');
  });
});
