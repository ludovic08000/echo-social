/**
 * Established-session freshness policy.
 *
 * A Signed PreKey is only an X3DH bootstrap input. Rotating the peer's SPK must
 * not invalidate an already-established Double Ratchet session: the session has
 * moved on to its own DH ratchet keys and no longer depends on that SPK.
 *
 * The previous implementation compared a device-scoped SPK id with the legacy
 * account-wide `get_signed_prekey` RPC. On multi-device accounts this produced
 * false mismatches, repeated local session purges and intermittent undecryptable
 * messages between iOS and Windows.
 *
 * Device-scoped bootstrap code already validates the current SPK immediately
 * before creating a new session. Therefore this compatibility probe is now a
 * deliberate no-op until all callers are removed from the conversation-level
 * legacy ratchet.
 */
export async function isPeerSPKStale(
  _peerUserId: string,
  _lastUsedSpkId: number | undefined,
): Promise<boolean> {
  return false;
}
