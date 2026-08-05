/**
 * Device routing identity is local to one logical installation.
 * It is never portable account material and must not be restored from a blob.
 */
export const LEGACY_DEVICE_ID_BACKUP_KEY = 'device:id' as const;

export function discardLegacyDeviceIdFromBackup(
  data: Record<string, unknown>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, LEGACY_DEVICE_ID_BACKUP_KEY)) {
    return false;
  }
  delete data[LEGACY_DEVICE_ID_BACKUP_KEY];
  return true;
}
