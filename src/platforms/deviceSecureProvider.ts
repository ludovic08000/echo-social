/**
 * Interface commune des fournisseurs sécurisés par plateforme.
 *
 * Invariant : cette interface est purement additive. Le chemin Windows
 * (WebAuthn / Windows Hello / device lifecycle) n'est PAS modifié et
 * n'implémente pas encore cette interface. Elle sert de socle à
 * l'architecture iOS isolée (platforms/ios).
 */

export type SecureProviderPlatform = 'ios' | 'android' | 'web' | 'windows' | 'unknown';

export interface SecureStorageStatus {
  /** Le coffre natif/logiciel répond en lecture/écriture. */
  available: boolean;
  /** Un aller-retour écriture -> lecture a réussi. */
  roundTripOk: boolean;
  tier: string;
  warnings: string[];
}

export interface HardwareEnclaveStatus {
  /** Enclave matérielle (Secure Enclave / TPM / StrongBox) exposée. */
  available: boolean;
  /** Détail lisible de la source de confiance. */
  backing: 'secure-enclave' | 'platform-keystore' | 'software' | 'unknown';
  reason: string | null;
}

export interface DeviceSecureProviderDiagnostics {
  platform: SecureProviderPlatform;
  isNativeRuntime: boolean;
  secureStorage: SecureStorageStatus;
  enclave: HardwareEnclaveStatus;
  /** Identité cryptographique locale présente pour ce couple user/device. */
  hasLocalIdentity: boolean;
  lastError: string | null;
  collectedAt: string;
}

export interface DeviceSecureProvider {
  readonly platform: SecureProviderPlatform;
  /** Le provider est-il utilisable dans le runtime courant ? */
  isSupported(): boolean;
  /** Lecture d'un secret critique (jamais de mirroir en clair). */
  getSecret(key: string): Promise<string | null>;
  /** Écriture d'un secret critique avec relecture obligatoire. */
  setSecret(key: string, value: string): Promise<void>;
  /** Suppression d'un secret critique avec relecture obligatoire. */
  removeSecret(key: string): Promise<void>;
  /** Présence d'une identité de device déjà scellée localement. */
  hasLocalIdentity(userId: string, deviceId: string): Promise<boolean>;
  /** Diagnostic non destructif, sans exposer de matériel secret. */
  collectDiagnostics(input?: { userId?: string | null; deviceId?: string | null }):
    Promise<DeviceSecureProviderDiagnostics>;
}
