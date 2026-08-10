/**
 * Legacy global E2EE restore dialog removed.
 *
 * Recovery is now handled by the canonical DeviceID / Windows Hello lifecycle.
 * This temporary no-op export prevents old App.tsx imports from breaking while
 * ensuring the password/recovery-key legacy UI cannot mount or intercept events.
 */
export function E2EERestorePromptDialog() {
  return null;
}
