
import {
  isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
} from '@/lib/messaging/messageCompatibility';

export const aegisCompatibilityModule = {
  isDeviceCopyWire: isAegisDeviceCopyWire,
  isMultiDeviceEnvelopeBody,
} as const;

export type AegisCompatibilityModule = typeof aegisCompatibilityModule;
export { isAegisDeviceCopyWire, isMultiDeviceEnvelopeBody };
