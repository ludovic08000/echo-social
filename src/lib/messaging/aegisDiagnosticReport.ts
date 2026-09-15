import { getDeviceFinalizationTrace } from '@/lib/device-manager/deviceFinalizationTrace';
import { readE2EETrace } from './e2eeTrace';

/** Export des tampons bornés, sans interroger ni exporter les coffres ou la session Auth. */
export function getAegisDiagnosticReport() {
  return {
    exportedAt: new Date().toISOString(),
    deviceFinalization: getDeviceFinalizationTrace(),
    messaging: readE2EETrace(),
  };
}
