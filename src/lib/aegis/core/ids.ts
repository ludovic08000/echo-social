
import { safeUUID } from '@/e2ee-session';

export const aegisIdModule = {
  uuid: safeUUID,
} as const;

export type AegisIdModule = typeof aegisIdModule;
