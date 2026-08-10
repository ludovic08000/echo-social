/**
 * Rapport de diagnostic iOS destiné à l'écran « Appareil connecté ».
 * Lecture seule : aucune écriture de secret, aucun appel réseau protocolaire.
 */
import type { DeviceSecureProviderDiagnostics } from '@/platforms/deviceSecureProvider';
import { iosDeviceProvider } from '@/platforms/ios/iosDeviceProvider';
import { hasIosDeviceIdAnchor } from '@/platforms/ios/iosDeviceIdAnchor';
import { iosDeviceIdStorageKey } from '@/platforms/ios/iosDeviceIdStorageKey';
import { getLastIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { collectIosPlatformMetadata } from '@/platforms/ios/iosPlatformMetadata';

export interface IosDeviceDiagnosticsReport {
  platform: string;
  appVersion: string | null;
  deviceModel: string | null;
  deviceId: string | null;
  deviceIdAnchored: boolean;
  keychainState: 'ok' | 'degraded' | 'unavailable';
  keychainTier: string;
  hasLocalIdentity: boolean;
  secureEnclaveAvailable: boolean;
  secureEnclaveBacking: string;
  bindingStatus: string | null;
  routingStatus: string | null;
  spkCount: number | null;
  opkCount: number | null;
  lastError: string | null;
  lastRpcError: string | null;
  collectedAt: string;
}


export interface IosDiagnosticsServerContext {
  bindingStatus?: string | null;
  routingStatus?: string | null;
  routingError?: string | null;
  spkCount?: number | null;
  opkCount?: number | null;
}

function keychainState(
  diagnostics: DeviceSecureProviderDiagnostics,
): IosDeviceDiagnosticsReport['keychainState'] {
  if (!diagnostics.secureStorage.available) return 'unavailable';
  return diagnostics.secureStorage.roundTripOk ? 'ok' : 'degraded';
}

export async function collectIosDeviceDiagnostics(args: {
  userId?: string | null;
  deviceId?: string | null;
  server?: IosDiagnosticsServerContext;
}): Promise<IosDeviceDiagnosticsReport> {
  const [diagnostics, metadata, deviceIdAnchored] = await Promise.all([
    iosDeviceProvider.collectDiagnostics({
      userId: args.userId ?? null,
      deviceId: args.deviceId ?? null,
    }),
    collectIosPlatformMetadata(),
    hasIosDeviceIdAnchor(iosDeviceIdStorageKey(args.userId ?? null)),
  ]);
  const rpcError = getLastIosRpcError();

  return {
    platform: diagnostics.isNativeRuntime ? 'iOS natif (Capacitor)' : 'iOS web (WebKit)',
    appVersion: metadata.appVersion,
    deviceModel: metadata.deviceModel,
    deviceId: args.deviceId ?? null,
    deviceIdAnchored,
    keychainState: keychainState(diagnostics),
    keychainTier: diagnostics.secureStorage.tier,
    hasLocalIdentity: diagnostics.hasLocalIdentity,
    secureEnclaveAvailable: diagnostics.enclave.available,
    secureEnclaveBacking: diagnostics.enclave.backing,
    bindingStatus: args.server?.bindingStatus ?? null,
    routingStatus: args.server?.routingStatus ?? null,
    spkCount: args.server?.spkCount ?? null,
    opkCount: args.server?.opkCount ?? null,
    lastError: args.server?.routingError ?? diagnostics.lastError,
    lastRpcError: rpcError ? `${rpcError.operation}: ${rpcError.message}` : null,
    collectedAt: diagnostics.collectedAt,
  };
}

