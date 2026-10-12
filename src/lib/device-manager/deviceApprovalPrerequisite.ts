/** La récupération est un prérequis, jamais une approbation implicite. */
export type DeviceApprovalPrerequisite = 'unknown' | 'ready' | 'account_recovery_required';

export class DeviceApprovalRecoveryRequiredError extends Error {
  constructor() {
    super('DEVICE_APPROVAL_ACCOUNT_RECOVERY_REQUIRED');
    this.name = 'DeviceApprovalRecoveryRequiredError';
  }
}
