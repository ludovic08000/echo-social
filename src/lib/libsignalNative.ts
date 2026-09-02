import { Capacitor, registerPlugin } from '@capacitor/core';

export interface LibSignalCapabilities {
  available: boolean;
  engine: string;
  platform: 'android' | 'web';
  pqxdh: boolean;
  kyber1024: boolean;
  nativeSelfTest: boolean;
}

export interface LibSignalSelfTestResult {
  ok: boolean;
  engine: string;
  protocol: 'PQXDH';
  sessionVersion: number;
  elapsedMs: number;
  roundTrips: number;
}


export interface LibSignalDeviceBundle {
  signalDeviceId: number;
  registrationId: number;
  identityKeyB64: string;
  signedPreKeyId: number;
  signedPreKeyB64: string;
  signedPreKeySignatureB64: string;
  kyberPreKeyId: number;
  kyberPreKeyB64: string;
  kyberPreKeySignatureB64: string;
  oneTimePreKeyId?: number | null;
  oneTimePreKeyB64?: string | null;
}
interface LibSignalNativePlugin {
  getCapabilities(): Promise<LibSignalCapabilities>;
  runSelfTest(): Promise<LibSignalSelfTestResult>;
  ensureDevice(input: { userId: string; deviceId: string }): Promise<LibSignalDeviceBundle>;
  encryptForDevice(input: { recipientUserId: string; recipientDeviceId: string; plaintext: string; bundle: LibSignalDeviceBundle }): Promise<{ messageType: 'prekey' | 'signal'; ciphertextB64: string }>;
  decryptFromDevice(input: { senderUserId: string; senderDeviceId: string; messageType: 'prekey' | 'signal'; ciphertextB64: string }): Promise<{ plaintext: string }>;
}

const nativePlugin = registerPlugin<LibSignalNativePlugin>('LibSignal');

export async function getLibSignalCapabilities(): Promise<LibSignalCapabilities> {
  if (Capacitor.getPlatform() !== 'android') {
    return { available: false, engine: 'aegis-webcrypto', platform: 'web', pqxdh: false, kyber1024: false, nativeSelfTest: false };
  }
  return nativePlugin.getCapabilities();
}

export async function runLibSignalSelfTest(): Promise<LibSignalSelfTestResult> {
  if (Capacitor.getPlatform() !== 'android') throw new Error('LIBSIGNAL_NATIVE_ANDROID_ONLY');
  return nativePlugin.runSelfTest();
}

export const libSignalNative = {
  getCapabilities: getLibSignalCapabilities,
  runSelfTest: runLibSignalSelfTest,
  ensureDevice: (input: { userId: string; deviceId: string }) => nativePlugin.ensureDevice(input),
  encryptForDevice: (input: Parameters<LibSignalNativePlugin['encryptForDevice']>[0]) => nativePlugin.encryptForDevice(input),
  decryptFromDevice: (input: Parameters<LibSignalNativePlugin['decryptFromDevice']>[0]) => nativePlugin.decryptFromDevice(input),
};