/**
 * Legacy local safety-number/contact-trust UI removed.
 *
 * Canonical Aegis device authorization and routing are authoritative. The old
 * localStorage trust override and synthetic safety-number dialog must not run.
 */
export function ContactVerificationDialog() {
  return null;
}

export function hasTrustedContactChange(_conversationId?: string): boolean {
  return false;
}
