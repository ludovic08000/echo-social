# Socle Device iOS Web — Device Vault ACE + restauration

Périmètre : iOS Web uniquement. Windows gelé, protocole E2EE (X3DH, ratchet, envoi/réception) inchangé.

## Constat de l'audit (vérifié dans le code)

- `src/lib/secureStore.ts` route déjà : natif → Keychain/AegisKeychain, navigateur → ACE Web (`webAegisEnclave.ts`, anchor AES-GCM non extractible + records authentifiés en IndexedDB).
- `src/lib/crypto/nativeKeyVault.ts` court-circuite tout sur Web : chaque fonction commence par `if (!isSecureStoreNative()) return`/`return null`. Le coffre n'est donc jamais utilisé côté navigateur.
- Conséquence directe, sur iOS Web les clés privées sont écrites en clair dans IndexedDB :
  - `deviceIdentity.ts` — `privateKeyJWK` Ed25519 dans le store `identity-keys` (`dbPut`).
  - `deviceKx.ts` — `privateKeyJWK` X25519 dans le même store.
  - `x3dh.ts` — `StoredSPK.privateKeyJWK` (SPK et OPK) dans le store `spk`, branche non native.
- `webDeviceKeyVault.ts` sait déjà sceller signing+kx avec la Master Key (AES-GCM + AAD), mais il n'est consommé que par `iosPasskeyProvider.ts` et `windowsHelloDeviceRecovery.ts` — pas par le stockage courant.
- Journalisation : `errorLogger.ts` écrit dans `crypto_error_logs` ; `device_platform_metadata` existe pour le contexte plateforme. Rien de spécifique iOS Web aujourd'hui.

## Ce qui sera fait

### 1. Couche Device Vault abstraite
Nouveau `src/lib/crypto/deviceVault.ts` : `readDeviceSecret / writeDeviceSecret / removeDeviceSecret` typés+validés.
- Natif : délègue à `nativeKeyVault.ts` (comportement actuel, inchangé).
- Web : scelle le JSON du record via `secureSetCriticalSecret` (ACE Web), donc AES-GCM non extractible ; plus aucun `privateKeyJWK` en clair.

### 2. Routage iOS Web vers ACE
`deviceIdentity.ts`, `deviceKx.ts`, `x3dh.ts` : remplacer les branches `isSecureStoreNative()` par un appel unique au Device Vault. Migration one-shot au premier accès : si un record clair existe encore dans IndexedDB, il est relu, réécrit scellé, puis l'entrée claire est supprimée. Aucune régénération de clé, aucun changement de DeviceID, aucun changement des signatures publiques de ces modules — Windows passe par le même chemin ACE Web déjà validé, sans modification de `windowsHelloDeviceRecovery.ts`.

### 3. Vault Supabase de restauration iOS
Nouvelle table `public.ios_device_web_vaults` (user_id, device_id, sealed_vault, iv, created_at/updated_at), RLS propriétaire strict + GRANTs. On y stocke uniquement le blob produit par `captureEncryptedWebDeviceVault` (scellé par la Master Key côté client, AAD user+device). Le serveur ne voit jamais de clé privée ni la Master Key.

### 4. Restauration automatique fail-closed
Un helper `iosDeviceVaultRestore.ts` ne restaure que si, cumulativement : runtime iOS Web, DeviceID local déjà connu, device `approved`+`active`+non révoqué côté serveur, `user_id` cohérent, et Master Key disponible en session. Sinon : aucun essai, aucune création silencieuse de DeviceID, on retombe sur le lifecycle canonique (LINK_REQUIRED / PENDING_APPROVAL).

### 5. Observabilité iOS
Événements structurés (sans secret) vers `crypto_error_logs` : `ios_web.vault.migrate`, `.seal`, `.unseal_fail`, `.restore_skipped(raison)`, `.restore_ok`, `.anchor_missing`. Affichage en lecture dans la section diagnostics iOS existante.

## Détails techniques

- Aucune modification de `windowsHelloDeviceRecovery.ts`, `WindowsHelloDeviceRecoverySection.tsx`, du protocole X3DH/ratchet, ni des API d'envoi/réception.
- Format de scellement unique (AES-GCM + AAD `user|device`), sans numéro de version applicatif supplémentaire.
- Tests ajoutés : round-trip vault Web, migration clair→scellé, échec fermé si anchor ACE absent, refus de restauration si device inconnu/incohérent, et non-régression sélection provider Windows.
- Vérification finale : `npx tsgo --noEmit -p tsconfig.app.json` + suites vitest crypto/platform ciblées. Aucun déploiement.

## Point à confirmer

La migration SQL (table `ios_device_web_vaults`) est le seul changement base de données ; elle sera proposée séparément pour validation avant exécution.
