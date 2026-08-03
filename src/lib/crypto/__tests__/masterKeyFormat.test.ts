import { describe, expect, it } from 'vitest';
import { masterKeyAADLabel } from '@/lib/crypto/masterKeyFormat';

describe('format unique de la Master Key Aegis', () => {
  it('lie le coffre au compte et à son usage sans numéro de version', () => {
    const account = masterKeyAADLabel('user-a', 'account');
    expect(account).toBe('forsure-aegis-vault|user-a|account');
    expect(account).not.toBe(masterKeyAADLabel('user-b', 'account'));
    expect(account).not.toBe(masterKeyAADLabel('user-a', 'recovery'));
    expect(account).not.toMatch(/(?:version|schema|v\d+)/i);
  });

  it('authentifie réellement le compte et le type avec AES-GCM', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const plaintext = encoder.encode('master-key-test');
    const aad = encoder.encode(masterKeyAADLabel('user-a', 'account'));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      plaintext,
    );

    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      ciphertext,
    );
    expect(new TextDecoder().decode(opened)).toBe('master-key-test');

    const wrongAccount = encoder.encode(masterKeyAADLabel('user-b', 'account'));
    await expect(crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: wrongAccount },
      key,
      ciphertext,
    )).rejects.toBeDefined();
  });
});
