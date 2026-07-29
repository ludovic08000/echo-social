
import {
  buildFanoutCopies,
  type FanoutCopyRow,
} from '@/lib/messaging/multiDeviceFanout';
import { rollbackFanoutSessionTransaction } from '@/lib/messaging/fanoutSessionTransaction';

export const aegisRoutingModule = {
  buildCopies: buildFanoutCopies,
  rollback: rollbackFanoutSessionTransaction,
} as const;

export type AegisRoutingModule = typeof aegisRoutingModule;
export type { FanoutCopyRow };
export { buildFanoutCopies, rollbackFanoutSessionTransaction };
