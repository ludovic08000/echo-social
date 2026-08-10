/**
 * Métadonnées plateforme iOS publiées dans l'extension device_platform_metadata.
 * Extension propre : la table user_devices et le flux Windows ne sont pas touchés.
 */
import { supabase } from '@/integrations/supabase/client';
import { inspectIosBridge } from '@/platforms/ios/capacitorBridge';
import { inspectIosSecureEnclave } from '@/platforms/ios/secureEnclave';
import { inspectIosKeychain } from '@/platforms/ios/keychain';
import { getLastIosRpcError, recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';

export interface IosPlatformMetadata {
  platform: 'ios';
  runtime: 'native' | 'web';
  appVersion: string | null;
  deviceModel: string | null;
  secureEnclaveAvailable: boolean;
  secureStorageTier: string;
}

let cachedAppVersion: string | null | undefined;

async function resolveAppVersion(isNative: boolean): Promise<string | null> {
  if (cachedAppVersion !== undefined) return cachedAppVersion;
  cachedAppVersion = null;
  try {
    if (isNative) {
      const { App } = await import('@capacitor/app');
      const info = await App.getInfo();
      cachedAppVersion = `${info.version}${info.build ? ` (${info.build})` : ''}`;
    } else {
      const response = await fetch('/version.json', { cache: 'no-store' });
      if (response.ok) {
        const json = await response.json() as { version?: string };
        cachedAppVersion = typeof json.version === 'string' ? json.version : null;
      }
    }
  } catch {
    cachedAppVersion = null;
  }
  return cachedAppVersion;
}

function resolveDeviceModel(userAgent: string): string | null {
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/iPod/i.test(userAgent)) return 'iPod';
  if (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return 'iPad';
  }
  return null;
}

export async function collectIosPlatformMetadata(): Promise<IosPlatformMetadata> {
  const bridge = inspectIosBridge();
  const [enclave, keychain, appVersion] = await Promise.all([
    inspectIosSecureEnclave(),
    inspectIosKeychain(),
    resolveAppVersion(bridge.isNativeIos),
  ]);

  return {
    platform: 'ios',
    runtime: bridge.isNativeIos ? 'native' : 'web',
    appVersion,
    deviceModel: resolveDeviceModel(bridge.userAgent),
    secureEnclaveAvailable: enclave.available,
    secureStorageTier: keychain.tier,
  };
}

/** Publie les métadonnées iOS pour un device déjà enregistré côté serveur. */
export async function publishIosPlatformMetadata(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const metadata = await collectIosPlatformMetadata();
  const { error } = await supabase
    .from('device_platform_metadata')
    .upsert({
      user_id: userId,
      device_id: deviceId,
      platform: metadata.platform,
      runtime: metadata.runtime,
      app_version: metadata.appVersion,
      device_model: metadata.deviceModel,
      secure_enclave_available: metadata.secureEnclaveAvailable,
      secure_storage_tier: metadata.secureStorageTier,
      last_error: getLastIosRpcError()?.message ?? null,
    }, { onConflict: 'user_id,device_id' });

  if (error) {
    recordIosRpcError('device_platform_metadata.upsert', error);
    return false;
  }
  return true;
}
