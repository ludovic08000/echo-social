# Suppression Windows Hello/WebAuthn + passage libsignal exclusif

Analyse du dépôt effectuée en lecture seule. Aucun fichier applicatif modifié.

## Etat constaté (vérifié)

- Le chemin message est **déjà** libsignal : `multiDeviceFanout.ts` n'utilise que `encryptForLibsignalDevice` / `decryptFromLibsignalDevice` (`libsignalRuntime.ts` → `libsignalPlatformBridge.ts` → natif Android/iOS ou `aegisWasmBridge.ts`). Le format de fil unique est `aegis.libsignal.<2|3>.<base64>` (`libsignalWire.ts`), et `libsignalOnly.test.ts` verrouille déjà cet invariant.
- Ce qui reste custom hors chemin message : `x3dh.ts` (786 l., SPK/OPK maison publiés par `deviceApi.prepareKeys`), `kdfChain.ts`, `aegisDeviceWire.ts` (préfixes `aegis1.ratchet.` / `aegis1.init.v1.`, encore lu par `messageCompatibility.ts`), `deviceSessionStore.ts`, `skippedKeyVault.ts`, `replayGuard.ts`, `securityEpoch.ts`, `deviceManifest.ts`, `deviceTransfer.ts`, ainsi que leurs ré-exports dans `src/lib/crypto/index.ts`.
- Windows Hello / WebAuthn actif : `windowsHelloDeviceRecovery.ts`, `windowsPasskeyProvider.ts`, `webauthnBrowser.ts`, `passkeyVault.ts`, `iosPasskeyProvider.ts` + `iosPasskeyState.ts`, la section UI `WindowsHelloDeviceRecoverySection.tsx` (montée par `DevicesPanel.tsx`), plus des imports dans `DeviceApprovalGate.tsx`, `useDeviceLifecycle.ts` (`isWindowsWeb`), `recoveryManager.ts`, `x3dh.ts:392`, `deviceSessionStore.ts:42`.
- Backend WebAuthn : fonction `supabase/functions/webauthn-device/index.ts`, endpoint `api/webauthn-device.mjs`, entrée `[functions.webauthn-device]` dans `config.toml`, workflow `deploy-webauthn-device.yml`, tables `webauthn_device_challenges`, `webauthn_device_credentials`, `webauthn_device_vaults` et migrations `20260810053000`, `20260810063000`, `20260810064500`, `20260812134500`.
- Backend custom X3DH : tables `device_signed_prekeys`, `device_one_time_prekeys`, `user_signed_prekeys`, `device_keys`, avec une porte de routage qui exige un SPK actif (`20260805164500_require_active_spk_for_device_routing.sql`). Côté production : 0 bundle libsignal publié, SPK = 0 — la porte actuelle bloque donc le chemin libsignal.

## Plan de migration, fichier par fichier

### Lot 1 — Retirer Windows Hello / WebAuthn (client)
- Supprimer : `src/lib/crypto/windowsHelloDeviceRecovery.ts`, `src/lib/crypto/passkeyVault.ts`, `src/platforms/shared/webauthnBrowser.ts`, `src/platforms/windows/windowsPasskeyProvider.ts`, `src/platforms/ios/iosPasskeyProvider.ts`, `src/platforms/ios/iosPasskeyState.ts`, `src/components/settings/WindowsHelloDeviceRecoverySection.tsx`, `src/lib/crypto/__tests__/deviceApprovalWindowsHelloRecovery.test.ts`.
- Nettoyer les appelants : `DevicesPanel.tsx` (retirer la section), `DeviceApprovalGate.tsx`, `useDeviceLifecycle.ts` (déplacer `isWindowsWeb` dans `src/lib/runtimePlatform.ts` si encore utile), `recoveryManager.ts` (import dynamique de `passkeyVault`), `platforms/deviceLifecycleCore.ts` + `platforms/ios/index.ts` + `iosDiagnostics.ts` (provider générique fail-closed), `src/lib/crypto/index.ts`.
- Les coffres de récupération restent ceux du chemin PIN/mot de passe (`secureBackupVault`, `recoveryKey`) : aucune récupération par biométrie ne subsiste.

### Lot 2 — Retirer la crypto message custom
- Supprimer : `x3dh.ts`, `kdfChain.ts`, `aegisDeviceWire.ts`, `deviceSessionStore.ts`, `skippedKeyVault.ts`, `replayGuard.ts` / `aegisReplayGuard.ts`, `securityEpoch.ts`, `deviceManifest.ts`, `deviceTransfer.ts` et leurs tests dédiés (`kdfChain.test.ts`, `aegisKdfConformance.test.ts`, `x3dhOpkClaim.test.ts`, `aegisDeviceWire.test.ts`, `aegisReplayGuard.test.ts`).
- `deviceApi.ts` : supprimer `refreshDeviceSignedPrekeyIfNeeded` / `refillDeviceOneTimePrekeysIfNeeded` de `prepareKeys` ; la seule publication de clés devient `provisionLibsignalDevice` + `mark_current_device_route_ready`.
- `messageCompatibility.ts` : ne garder que `decodeLibsignalWire` ; tout `aegis1.*` devient `unsupported` (bulle « message d'une ancienne version », jamais de déchiffrement de secours).
- `webDeviceKeyVault.ts`, `devicePrekeyRepair.ts`, `postRestoreSync.ts`, `keyManager.ts`, `index.ts` : retirer les types/snapshots X3DH devenus morts.
- `deviceKx.ts` est conservé : il sert au binding d'appareil et aux appels (`aegisCallProtocol.ts`), pas au chiffrement des messages.
- Un commentaire français court documente chaque invariant corrigé aux points de bascule (`deviceApi.prepareKeys`, `messageCompatibility`, `libsignalProvisioning`).

### Lot 3 — Stockage libsignal
- Source unique : le store libsignal scellé dans `device_encrypted_vaults` via `deviceVault.ts` (clé `aegis.libsignal.store:<user>:<device>`), verrou `libsignalStoreLock.ts`, fraîcheur `libsignalSessionFreshness.ts`. Rien à ajouter ; supprimer seulement les stores parallèles (sessions X3DH, clés sautées) devenus orphelins.

### Lot 4 — Invalidation des anciennes sessions
- Migration additive : marquer les appareils sans bundle libsignal en `routing_status='repairing'` pour forcer une re-provision propre, purger les lignes `message_device_copies` au format `aegis1.*` non déchiffrables et les anciennes tables de préclés custom (aucun message clair ni compte supprimé).
- Remplacer la porte `require_active_spk_for_device_routing` par une porte « bundle libsignal présent » : sans ce changement, la production reste bloquée (SPK = 0).

### Lot 5 — Backend
- Supprimer la fonction `webauthn-device` et son entrée `config.toml`, `api/webauthn-device.mjs`, `.github/workflows/deploy-webauthn-device.yml`.
- Migration additive : retirer les RPC WebAuthn et les tables `webauthn_device_*`, puis les tables `device_signed_prekeys`, `device_one_time_prekeys`, `user_signed_prekeys` une fois le code client déployé (ordre : client d'abord, suppression ensuite).

### Lot 6 — Tests et validation
- Etendre `libsignalOnly.test.ts` : absence des fichiers supprimés, aucun `aegis1.` dans le chemin d'envoi, aucun import WebAuthn.
- Nouveaux tests : `messageCompatibility` rejette `aegis1.*`, `deviceApi.prepareKeys` ne publie que des bundles libsignal, `deviceLifecycleCore` renvoie le provider générique.
- Commandes : `npx vitest run`, `npm run typecheck`, `npm run build`, `node scripts/verify-libsignal-wasm.mjs`, tests SQL `supabase/tests/*.sql`.
- Aucun commit direct ni fusion dans `main` : travail sur branche dédiée, PR soumise à la CI E2EE.

## Risques à assumer
- Rupture volontaire : les anciens messages `aegis1.*` deviennent définitivement illisibles (conforme à AGENTS.md — remplacer, pas empiler).
- La suppression de Windows Hello enlève une voie de récupération sur Windows ; le PIN/mot de passe et la clé de récupération restent obligatoires.
- Ordre de déploiement strict : client libsignal-only publié avant la suppression des tables, sinon les clients en place perdent leur route.

## Section technique
Ordre recommandé : Lot 1 → Lot 2 → Lot 6 (vert) → Lot 4/5 en fenêtre de maintenance. Le lifecycle canonique (AUTHENTICATED → … → MESSAGING_READY) et le fail-closed restent inchangés ; seule la source des clés passe de `x3dh.ts` à `libsignalProvisioning.ts`.
