/**
 * Read-only diagnostics for the iOS Web Passkey device flow.
 * No Keychain/Secure Enclave/Capacitor assumptions are exposed here.
 */
import { getLastIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { getIosPasskeyDebugState } from '@/platforms/ios/iosPasskeyState';
import {
  getIosPasskeyStatus,
  isIosPasskeySupported,
} from '@/platforms/ios/iosPasskeyProvider';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

export interface IosDeviceDiagnosticsReport {
  platform: string;
  deviceId: string | null;
  bindingStatus: string | null;
  routingStatus: string | null;
  spkCount: number | null;
  opkCount: number | null;
  lastError: string | null;
  lastRpcError: string | null;
  passkeySupported: boolean;
  passkeyRegistered: boolean | null;
  passkeyLastError: string | null;
  collectedAt: string;
}

export interface IosDiagnosticsServerContext {
  bindingStatus?: string | null;
  routingStatus?: string | null;
  routingError?: string | null;
  spkCount?: number | null;
  opkCount?: number | null;
}

export async function collectIosDeviceDiagnostics(args: {
  userId?: string | null;
  deviceId?: string | null;
  server?: IosDiagnosticsServerContext;
}): Promise<IosDeviceDiagnosticsReport> {
  const iosWeb = isIosWebRuntime();
  const passkeySupported = iosWeb ? await isIosPasskeySupported() : false;
  let passkeyRegistered: boolean | null = null;

  if (iosWeb && passkeySupported && args.deviceId) {
    passkeyRegistered = await getIosPasskeyStatus(args.deviceId);
  }

  const passkey = getIosPasskeyDebugState();
  const rpcError = getLastIosRpcError();

  return {
    platform: iosWeb ? 'iOS Web · WebAuthn/Passkey' : 'non-iOS',
    deviceId: args.deviceId ?? null,
    bindingStatus: args.server?.bindingStatus ?? null,
    routingStatus: args.server?.routingStatus ?? null,
    spkCount: args.server?.spkCount ?? null,
    opkCount: args.server?.opkCount ?? null,
    lastError: args.server?.routingError ?? null,
    lastRpcError: rpcError ? `${rpcError.operation}: ${rpcError.message}` : null,
    passkeySupported,
    passkeyRegistered: passkeyRegistered ?? passkey.registered,
    passkeyLastError: passkey.lastError,
    collectedAt: new Date().toISOString(),
  };
}
