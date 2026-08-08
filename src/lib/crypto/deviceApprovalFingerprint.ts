/**
 * Empreinte d'appareil affichée avant approbation (cérémonie de comparaison).
 *
 * Modèle de menace — à lire avant toute évolution :
 * - L'empreinte est calculée localement à partir du DeviceID et des DEUX clés
 *   publiques de l'appareil (X25519 de transport + Ed25519 de signature).
 * - Elle protège contre une SUBSTITUTION de clés : si le serveur (ou un
 *   attaquant réseau) présente à l'approbateur des clés différentes de celles
 *   réellement détenues par le nouvel appareil, les deux écrans afficheront des
 *   valeurs différentes.
 * - Elle NE prétend PAS qu'un serveur compromis ne peut pas influencer la
 *   valeur : côté approbateur, les clés proviennent du serveur. La garantie
 *   vient uniquement de la comparaison humaine hors-bande avec la valeur
 *   calculée sur l'appareil en attente à partir de ses clés LOCALES.
 * - Une empreinte identique ne prouve rien si l'utilisateur n'a pas comparé les
 *   deux écrans lui-même.
 *
 * Primitives : WebCrypto SHA-512 uniquement (compatible iOS/Safari).
 */
import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { encodeString } from '@/lib/crypto/utils';

export const DEVICE_FINGERPRINT_ITERATIONS = 5200;
export const DEVICE_FINGERPRINT_GROUPS = 6;
const GROUP_DIGITS = 5;
const GROUP_BYTES = 5;

export interface DeviceFingerprintInput {
  deviceId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}

function canonicalDeviceFingerprintPayload(input: DeviceFingerprintInput): string {
  return [
    'forsure-aegis-device-fingerprint',
    'v1',
    input.deviceId.trim(),
    input.devicePublicKey.trim(),
    input.deviceSigningKey.trim(),
  ].join('|');
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Chaîne itérative de type Signal : coût fixe, sortie stable. */
async function iterativeSha512(seed: Uint8Array, iterations: number): Promise<Uint8Array> {
  let digest = seed;
  for (let i = 0; i < iterations; i += 1) {
    digest = new Uint8Array(await hardCrypto.digest('SHA-512', concat(digest, seed)));
  }
  return digest;
}

function groupsFromDigest(digest: Uint8Array): string[] {
  const groups: string[] = [];
  for (let index = 0; index < DEVICE_FINGERPRINT_GROUPS; index += 1) {
    const offset = index * GROUP_BYTES;
    let value = 0;
    for (let byte = 0; byte < GROUP_BYTES; byte += 1) {
      value = (value * 256 + digest[offset + byte]) % 100000;
    }
    groups.push(String(value).padStart(GROUP_DIGITS, '0'));
  }
  return groups;
}

/** Renvoie 6 groupes de 5 chiffres, ex. "12345 67890 ...". */
export async function computeDeviceApprovalFingerprint(
  input: DeviceFingerprintInput,
): Promise<string> {
  if (!input.deviceId || !input.devicePublicKey || !input.deviceSigningKey) {
    throw new Error('DEVICE_FINGERPRINT_INPUT_INCOMPLETE');
  }
  const seed = encodeString(canonicalDeviceFingerprintPayload(input));
  const digest = await iterativeSha512(seed, DEVICE_FINGERPRINT_ITERATIONS);
  return groupsFromDigest(digest).join(' ');
}

/** Formatage d'affichage : deux lignes de trois groupes. */
export function formatDeviceApprovalFingerprint(fingerprint: string): string[] {
  const groups = fingerprint.split(/\s+/).filter(Boolean);
  return [groups.slice(0, 3).join(' '), groups.slice(3).join(' ')].filter(Boolean);
}
