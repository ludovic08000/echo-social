/**
 * Legacy restore/safety-number UI removed.
 *
 * Kept as a temporary no-op export because App.tsx still imports this symbol.
 * The canonical device/Windows Hello recovery flow owns recovery UX now.
 */
export function SafetyNumberRevalidationBanner() {
  return null;
}
