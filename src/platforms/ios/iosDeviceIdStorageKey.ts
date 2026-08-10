/**
 * Clé de stockage du DeviceID, identique à celle du routeur canonique
 * (`forsure-device-id-v1:<userId>`). Isolée ici pour éviter toute dépendance
 * circulaire entre l'adaptateur iOS et le module currentDevice.
 */
const BASE_STORAGE_KEY = 'forsure-device-id-v1';

export function iosDeviceIdStorageKey(userId: string | null | undefined): string {
  return userId ? `${BASE_STORAGE_KEY}:${userId}` : BASE_STORAGE_KEY;
}
