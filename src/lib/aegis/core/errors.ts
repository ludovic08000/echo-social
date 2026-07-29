
import type { OutboxStatus } from '@/lib/messaging/outboxVault';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Echec du transport chiffre.');
  }
  return String(error ?? 'Echec du transport chiffre.');
}

export function failureStatus(error: unknown): OutboxStatus {
  const text = errorMessage(error).toLowerCase();
  if (
    text.includes('401') ||
    text.includes('jwt') ||
    text.includes('not_authenticated') ||
    text.includes('pin unlock required') ||
    text.includes('verification obligatoire') ||
    text.includes('fingerprint changed') ||
    text.includes('fingerprint_changed')
  ) {
    return 'failed_visible';
  }
  if (
    text.includes('e2ee_device') ||
    text.includes('e2ee_sender_device_not_trusted') ||
    text.includes('e2ee_sender_device_required') ||
    text.includes('e2ee_participant_route_unavailable') ||
    text.includes('e2ee_no_secure_target') ||
    text.includes('device_prekey_bundle_unavailable') ||
    text.includes('signed_device_list_missing') ||
    text.includes('device_spk_signature_invalid')
  ) {
    return 'waiting_secure_channel';
  }
  return 'retry_pending';
}

export function requestSenderTrustRepair(error: unknown): void {
  const text = errorMessage(error).toLowerCase();
  if (
    !text.includes('e2ee_sender_device_not_trusted') &&
    !text.includes('e2ee_sender_device_required')
  ) {
    return;
  }

  try {
    window.dispatchEvent(new CustomEvent('forsure:device-self-repair-required', {
      detail: { reason: 'sender-route-not-trusted' },
    }));
  } catch {
    // Browser event delivery is best-effort outside the DOM runtime.
  }
}
