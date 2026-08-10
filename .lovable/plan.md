# Audit iOS — bascule Capacitor/Keychain vers iOS Web pur + WebAuthn

Audit lecture seule. Aucun fichier modifié. Le flux Windows (`src/lib/crypto/windowsHelloDeviceRecovery.ts`, `src/components/settings/WindowsHelloDeviceRecoverySection.tsx`, `src/platforms/windows/windowsPasskeyProvider.ts`) n'est touché par aucune proposition ci-dessous.

## 1) Graphe exact des références

**`src/platforms/ios/capacitorBridge.ts`** (importe `@capacitor/core` + `isVerifiedNativeRuntime`)
- `src/platforms/deviceLifecycleCore.ts:14` (`isIosRuntime`)
- `src/platforms/ios/iosDeviceIdAnchor.ts:11`
- `src/platforms/ios/iosDeviceReuse.ts:12`
- `src/platforms/ios/iosLifecycleAdapter.ts:8`
- `src/platforms/ios/iosDeviceProvider.ts:12`
- `src/platforms/ios/iosPasskeyProvider.ts:23`
- `src/platforms/ios/iosPlatformMetadata.ts:6`
- `src/platforms/ios/secureEnclave.ts:8`
- `src/components/settings/IosDeviceDiagnosticsSection.tsx:4`
- `src/platforms/ios/index.ts:1`
- tests : `src/platforms/__tests__/deviceLifecycleCore.test.ts:6`, `src/platforms/ios/__tests__/{iosDeviceIdAnchor,iosDeviceReuse,iosLifecycleAdapter}.test.ts`

**`src/platforms/ios/iosDeviceIdAnchor.ts`**
- `src/lib/messaging/currentDevice.ts:17` (écriture ligne 152, lecture ligne 285)
- `src/platforms/ios/iosDeviceReuse.ts:13`, `iosLifecycleAdapter.ts:9`, `iosDiagnostics.ts:7`
- test : `src/platforms/ios/__tests__/iosDeviceIdAnchor.test.ts`

**`src/platforms/ios/iosDeviceReuse.ts`**
- `src/lib/api/deviceApi.ts:44` (appel `adoptReusableIosDevice` ligne 202, avant enrôlement)
- test : `src/platforms/ios/__tests__/iosDeviceReuse.test.ts`

**`src/platforms/ios/iosLifecycleAdapter.ts`**
- `src/hooks/useDeviceLifecycle.ts:23` (appel ligne 133)
- test : `src/platforms/ios/__tests__/iosLifecycleAdapter.test.ts`

**`src/platforms/ios/keychain.ts`** (délègue à `src/lib/secureStore.ts`)
- `iosDeviceIdAnchor.ts:10`, `iosDeviceProvider.ts:19`, `secureEnclave.ts:9`, `iosPlatformMetadata.ts:8`, `index.ts:2`

**`src/platforms/ios/secureEnclave.ts`**
- `iosDeviceProvider.ts:20`, `iosPlatformMetadata.ts:7`, `index.ts:3`

**`src/platforms/ios/iosDeviceProvider.ts`**
- `src/platforms/ios/iosDiagnostics.ts:6,60`, `index.ts:4`

**`src/platforms/deviceSecureProvider.ts`** (types uniquement)
- `iosDeviceProvider.ts:11`, `keychain.ts:15`, `secureEnclave.ts:7`, `iosDiagnostics.ts:5`

## 2) Supprimables sans casse (après retrait des 3 points d'appel)

Supprimables intégralement :
- `src/platforms/ios/iosDeviceProvider.ts` — consommé uniquement par `iosDiagnostics.ts`
- `src/platforms/ios/secureEnclave.ts`
- `src/platforms/ios/keychain.ts`
- `src/platforms/deviceSecureProvider.ts` (types morts une fois les 4 fichiers ci-dessus supprimés)
- `src/platforms/ios/iosDeviceIdAnchor.ts` + `iosDeviceReuse.ts` + `iosLifecycleAdapter.ts` — mais chacun a un point d'appel runtime à retirer d'abord (`currentDevice.ts`, `deviceApi.ts`, `useDeviceLifecycle.ts`)
- `src/platforms/ios/capacitorBridge.ts` — à remplacer, pas à supprimer sèchement (7 importeurs)

Attention : `src/platforms/ios/iosDeviceIdStorageKey.ts` doit rester (clé canonique) si l'ancrage est remplacé par un stockage web.

Non supprimables ici (hors périmètre iOS) : `src/lib/secureStore.ts`, `src/lib/nativeStore.ts`, `src/lib/runtimePlatform.ts` — utilisés par `deviceIdentity.ts`, `deviceKx.ts`, `x3dh.ts`, `keySentinel.ts`, `accountKeyBackup.ts`, `nativeKeyVault.ts`, `useChatPin.ts`, `e2eeCleanStartup.ts`, `currentDevice.ts`.

## 3) À modifier pour un détecteur iOS navigateur pur

- **Nouveau** `src/platforms/ios/iosRuntime.ts` : `isIosWebRuntime()` basé uniquement sur UA `/(iPhone|iPad|iPod)/` + `navigator.platform === 'MacIntel' && maxTouchPoints > 1`, sans `@capacitor/core` ni `isVerifiedNativeRuntime`.
- `src/platforms/deviceLifecycleCore.ts:14,39` — importer le nouveau détecteur ; ordre `ios` avant `windows` conservé.
- `src/platforms/ios/iosPasskeyProvider.ts:23` — même remplacement d'import ; c'est le seul chemin iOS conservé.
- `src/platforms/ios/iosDiagnostics.ts` — retirer `iosDeviceProvider`/`hasIosDeviceIdAnchor` ; ne garder que DeviceID, binding/routing serveur, SPK/OPK, support + credential passkey, erreurs. Les champs `keychainState/keychainTier/secureEnclave*/hasLocalIdentity/deviceIdAnchored` disparaissent.
- `src/components/settings/IosDeviceDiagnosticsSection.tsx:4,70-75` — nouvel import + suppression des lignes Keychain / Secure Enclave / DeviceID ancré.
- `src/platforms/ios/iosPlatformMetadata.ts:6-8,27` — retirer keychain/enclave/`@capacitor/app` ; publier des métadonnées web (UA, standalone PWA, support passkey) ou supprimer si l'adapter disparaît.
- `src/platforms/ios/index.ts` — réécrire les exports (retirer keychain/secureEnclave/iosDeviceProvider/capacitorBridge).
- `src/lib/messaging/currentDevice.ts:17,152,285-286` — retirer l'ancrage Keychain ; la ligne 325 (détection `'ios'`) est déjà UA pure, à conserver.
- `src/lib/api/deviceApi.ts:44,202-204` — retirer `adoptReusableIosDevice` ; la réutilisation d'appareil iOS passe par la récupération passkey (`webauthn_recover_device_vault_rpc`), pas par un ancrage local.
- `src/hooks/useDeviceLifecycle.ts:23,133` — retirer `syncIosDeviceAdapter` ou le remplacer par la variante web de publication de métadonnées.

Note : `iosPasskeyProvider` parle aujourd'hui aux RPC (`webauthn_device_status`, `webauthn_begin_device_registration`, `webauthn_finalize_device_registration_rpc`, `webauthn_begin_device_recovery`, `webauthn_recover_device_vault_rpc`). `api/webauthn-device.mjs` expose les mêmes cérémonies côté serveur (`status`, `register-options`, `register-verify`, `recover-options`, `recover-verify`) avec vérification serveur de la preuve. Basculer iOS sur cet endpoint est le point de décision principal ; c'est un changement de transport dans `iosPasskeyProvider.ts` seul, Windows continuant sur les RPC.

## 4) Points de branchement UI

- **Activation Passkey sur device READY** : `src/components/settings/DevicesPanel.tsx:368`, à côté de `IosDeviceDiagnosticsSection`, dans le bloc de l'appareil courant. Condition d'affichage : `isIosWebRuntime()` + `deviceId` valide + `record.routingStatus === 'ready'` (état exposé par `useDeviceLifecycle`) + `isIosPasskeySupported()`, et bouton masqué si `getIosPasskeyStatus(deviceId)` est vrai. Appelle `registerIosPasskey`. Ligne 257 (`WindowsHelloDeviceRecoverySection`) reste inchangée et mutuellement exclusive.
- **Récupération** : `src/components/messaging/DeviceApprovalGate.tsx` — ajouter une branche iOS symétrique au bloc `recoverWithWindowsHello` (lignes 41-60 + bouton lignes ~140-147), appelant `recoverIosDeviceWithPasskey(user.id)` après le même déverrouillage Master Key (`getSessionMasterKey()` / `initAccountKeySync(password, userId)`). Aucune modification du chemin Windows existant : nouvelle fonction, nouveau bouton, sélection par `isIosWebRuntime()`.
- L'ordre canonique reste respecté : la passkey n'est proposée qu'après APPROVED/READY, et la récupération ne crée jamais de DeviceID (`setCurrentDeviceId` sur l'ID renvoyé par le serveur).

## 5) Tests

Casseront (à supprimer avec les modules) :
- `src/platforms/ios/__tests__/iosDeviceIdAnchor.test.ts`
- `src/platforms/ios/__tests__/iosDeviceReuse.test.ts`
- `src/platforms/ios/__tests__/iosLifecycleAdapter.test.ts`

À adapter :
- `src/platforms/__tests__/deviceLifecycleCore.test.ts:6` — le mock `@/platforms/ios/capacitorBridge` devient un mock du nouveau détecteur.

Probablement obsolètes (couvrent le stockage natif iOS) : `src/lib/crypto/__tests__/iosSecureStoreRuntimeConstraints.test.ts`, `iosNativeKeyVault.test.ts`, `iosDeviceKxPersistenceRuntime.test.ts`, `iosDeviceSigningPersistenceRuntime.test.ts` — à vérifier un par un car ils testent `secureStore`/`nativeKeyVault`, qui restent utilisés hors iOS.

À ajouter :
- détection iOS web pure (UA iPhone/iPad, iPadOS MacIntel, non-iOS négatif) ;
- non-régression : sur runtime Windows simulé, `resolveDevicePlatformProvider()` renvoie `windows` et aucun module iOS n'est chargé ;
- `iosPasskeyProvider` : `PASSKEY_IOS_ONLY` hors iOS, register refusé si device non ready, recover adopte le DeviceID serveur sans en générer ;
- `currentDevice` : plus aucune lecture d'ancrage Keychain dans la résolution des candidats.

## 6) Dépendances non-iOS

Confirmé : aucun code non-iOS ne dépend de `capacitorBridge`, `iosDeviceIdAnchor`, `iosDeviceReuse`, `iosLifecycleAdapter`, `platforms/ios/keychain`, `platforms/ios/secureEnclave`, `iosDeviceProvider`, `deviceSecureProvider`. Les seuls consommateurs hors dossier `platforms/ios/` sont trois points d'intégration iOS-gated (`currentDevice.ts`, `deviceApi.ts`, `useDeviceLifecycle.ts`, tous no-op hors iOS) et `IosDeviceDiagnosticsSection.tsx`.

Les usages restants de Capacitor dans le projet sont indépendants du lifecycle device : `InviteContacts.tsx` (Share), `useContactSync.ts`, `importContacts.ts`, `Onboarding.tsx`, `platformPermissions.ts`, `nativeStore.ts`, `secureStore.ts`, `runtimePlatform.ts`, `useAccountKeySync.ts:290`. Retirer Capacitor de la chaîne iOS device n'oblige pas à retirer la dépendance du projet.
