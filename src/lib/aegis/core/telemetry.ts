
import { traceE2EE } from '@/lib/messaging/e2eeTrace';

export const aegisTelemetryModule = {
  trace: traceE2EE,
} as const;

export type AegisTelemetryModule = typeof aegisTelemetryModule;
