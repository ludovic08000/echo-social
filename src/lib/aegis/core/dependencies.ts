
import {
  aegisCompatibilityModule,
  type AegisCompatibilityModule,
} from '@/lib/aegis/compatibility';
import { aegisCryptoModule, type AegisCryptoModule } from '@/lib/aegis/crypto';
import { aegisDeviceModule, type AegisDeviceModule } from '@/lib/aegis/device';
import { aegisQueueModule, type AegisQueueModule } from '@/lib/aegis/queue';
import { aegisRecoveryModule, type AegisRecoveryModule } from '@/lib/aegis/recovery';
import { aegisRoutingModule, type AegisRoutingModule } from '@/lib/aegis/routing';
import { aegisTransportModule, type AegisTransportModule } from '@/lib/aegis/transport';
import { aegisIdModule, type AegisIdModule } from './ids';
import { aegisTelemetryModule, type AegisTelemetryModule } from './telemetry';

export interface AegisRuntimeDependencies {
  ids: AegisIdModule;
  device: AegisDeviceModule;
  crypto: AegisCryptoModule;
  routing: AegisRoutingModule;
  transport: AegisTransportModule;
  queue: AegisQueueModule;
  recovery: AegisRecoveryModule;
  compatibility: AegisCompatibilityModule;
  telemetry: AegisTelemetryModule;
}

export const defaultAegisDependencies: AegisRuntimeDependencies = Object.freeze({
  ids: aegisIdModule,
  device: aegisDeviceModule,
  crypto: aegisCryptoModule,
  routing: aegisRoutingModule,
  transport: aegisTransportModule,
  queue: aegisQueueModule,
  recovery: aegisRecoveryModule,
  compatibility: aegisCompatibilityModule,
  telemetry: aegisTelemetryModule,
});
