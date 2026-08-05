import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('ios/App/App/AegisKeychainPlugin.swift', 'utf8');

describe('native iOS Aegis Keychain contract', () => {
  it('binds records to the physical device and disables backup migration', () => {
    expect(source).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(source).toContain('kSecClassGenericPassword');
    expect(source).toContain('AegisKeychain');
  });

  it('does not log or return private values outside the requested read', () => {
    expect(source).not.toContain('print(');
    expect(source).not.toContain('NSLog');
    expect(source).not.toContain('kSecAttrSynchronizable');
  });
});
