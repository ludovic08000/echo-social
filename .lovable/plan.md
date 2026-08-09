# Ordre strict du cycle de vie appareil (Aegis V1)

Analyse faite sur HEAD `702ae1d6`. Objectif : imposer
`AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK -> LINK_REQUIRED/PENDING_APPROVAL -> APPROVED_LOCKED -> PIN_UNLOCK -> ACCOUNT_KEY_SYNC -> MESSAGING_READY`
sans casser l'existant.

## Ce que le code fait aujourd'hui (vérifié)

- `src/App.tsx:193-205` monte `useAccountKeySync()`, `useCryptoMaintenance()`, `useDeviceRegistration()`, `usePendingDeviceApprovalAlert()`, `useDeviceCopyRetryWorker()`, `startRealtimeKeySync()` et `startAegisDeviceInbox()` dès qu'un utilisateur est authentifié — donc avant toute approbation d'appareil et avant tout PIN.
- `src/components/MessagingPinGate.tsx` est PIN-first : après les écrans d'identité, il affiche directement PinSetup/PinEntry. Aucun écran Approuver/Refuser n'existe avant le PIN.
- `src/lib/messaging/currentDevice.ts:229/241/266` lève `DeviceIdentityError` (`DEVICE_ID_UNINITIALIZED`, `DEVICE_ID_REAPPROVAL_REQUIRED`) — et `usePendingDeviceApprovalAlert.ts:43` appelle `getCurrentDeviceId()` sans try/catch, donc une exception fatale dans un hook global.
- `src/hooks/useDeviceRegistration.ts` appelle `restartWithFreshServerDevice()` (donc `rotateCurrentDeviceId`) depuis des chemins d'erreur/catch (`device-private-key-missing`, `device-key-mismatch`, `account-device-authorization-changed`, `verified-route-check-failed`, `cancelled-server-enrollment`) : génération silencieuse d'un nouveau DeviceID.
- `src/lib/device-manager/currentDevice.ts:14-21` autorise encore la rotation automatique via `aegis-device-private-key-missing`.
- Après approbation, la même fonction enchaîne SPK/OPK, `mark_current_device_route_ready`, `ensureApprovedDeviceTrust`, `beginAccountSynchronization` + `syncAegisDeviceInbox` sans jamais vérifier que le PIN est déverrouillé.
- `supabase/functions/approve-device-enrollment/index.ts:229` refuse `approver_device_id === target_device_id` : aucune auto-approbation V1 possible aujourd'hui.

## Correctif proposé (minimal, non régressif)

### 1. Machine d'état explicite (nouveau)

`src/lib/device-manager/deviceLifecycleMachine.ts`
- Type `AegisDeviceLifecycleState = 'AUTHENTICATED' | 'DEVICE_CREDENTIAL_CHECK' | 'LINK_REQUIRED' | 'PENDING_APPROVAL' | 'APPROVED_LOCKED' | 'PIN_UNLOCK' | 'ACCOUNT_KEY_SYNC' | 'MESSAGING_READY'`.
- `resolveDeviceLifecycleState({ deviceIdStatus, deviceRow, pinUnlocked, accountSyncPhase })` : fonction pure, ordonnée, sans effet de bord.
- Mapping : DeviceID absent/incohérent -> `LINK_REQUIRED` (jamais exception) ; ligne `user_devices` absente ou `approval_status='pending'` -> `PENDING_APPROVAL` ; approuvée+active -> `APPROVED_LOCKED` ; PIN déverrouillé -> `PIN_UNLOCK` ; sync en cours -> `ACCOUNT_KEY_SYNC` ; sync `ready` -> `MESSAGING_READY`.
- `canRunCryptoRuntime(state)` = state >= `PIN_UNLOCK` ; `canRunDeviceCredentialWork(state)` = state >= `DEVICE_CREDENTIAL_CHECK`.

`src/hooks/useDeviceLifecycle.ts` (nouveau) : lit `user_devices` (Realtime déjà en place) + statut DeviceID + `useChatPin().unlocked` + `getAccountSynchronizationPhase()`, expose `{ state, deviceRow, refresh, selfApprove, reject }`.

### 2. États contrôlés au lieu d'exceptions fatales

`src/lib/messaging/currentDevice.ts`
- Ajouter `peekCurrentDeviceId(): string | null` et `getDeviceIdStatus(): 'ok' | 'uninitialized' | 'mismatch' | 'storage_unavailable'` (aucune levée).
- `getCurrentDeviceId()` / `hydrateDeviceId()` conservent leur contrat fail-closed (pas de régression pour les appelants crypto).
- `usePendingDeviceApprovalAlert.ts:43` : remplacer `getCurrentDeviceId()` par `peekCurrentDeviceId()`.
- Auditer et corriger les autres appels `getCurrentDeviceId()` faits hors try/catch dans du code de rendu.

### 3. UI Approuver/Refuser AVANT le PIN

`src/components/messaging/DeviceApprovalGate.tsx` (nouveau)
- Écrans : `LINK_REQUIRED` (enrôler cet appareil, action explicite utilisateur -> `beginExplicitDeviceEnrollment`), `PENDING_APPROVAL` (empreinte d'approbation affichée via `computeDeviceApprovalFingerprint`, boutons **Approuver cet appareil** / **Refuser**), `REJECTED/REVOKED` (fail-closed, aucun contournement).
- Les signaux matériels (UA, timezone, écran) sont affichés en contexte/risque uniquement, jamais utilisés pour décider de la confiance.

`src/components/MessagingPinGate.tsx`
- Insérer le gate **avant** tout rendu PIN : si `state` ∈ {`LINK_REQUIRED`, `PENDING_APPROVAL`, rejeté} -> `DeviceApprovalGate`. Le cycle PIN existant n'est atteint qu'à partir de `APPROVED_LOCKED`.

### 4. Auto-approbation V1 (sans QR ni email)

`supabase/functions/approve-device-enrollment/index.ts`
- Nouvelle branche `self_approval: true` où `approver_device_id === target_device_id` est autorisé **uniquement si** le compte n'a aucun autre appareil approuvé, actif et non révoqué (premier/seul appareil). Sinon la règle actuelle `DEVICE_SELF_APPROVAL_FORBIDDEN` reste inchangée.
- La preuve de possession existante (challenge consommé, signature Ed25519 de l'appareil cible) reste obligatoire : l'auto-approbation ne saute aucune vérification cryptographique.
- Si un autre appareil approuvé existe, l'UI affiche « approuvez depuis votre appareil déjà connecté » — comportement actuel préservé.

`src/lib/crypto/deviceApprovalDecision.ts` : ajouter `submitSelfDeviceApproval()` (payload canonique dédié, `decision`, `selfApproval: true`) sans modifier le chemin multi-appareils existant.

### 5. Aucun runtime crypto avant APPROVED_LOCKED + PIN

`src/App.tsx`
- Scinder `AccountKeySyncRunner` en deux : un `DeviceLifecycleRunner` (toujours monté, ne fait que `useDeviceRegistration` limité à l'enrôlement/credential-check + `usePendingDeviceApprovalAlert`) et un `MessagingRuntimeRunner` monté conditionnellement quand `canRunCryptoRuntime(state)`.
- `useAccountKeySync`, `useCryptoMaintenance`, `useDeviceCopyRetryWorker`, `startRealtimeKeySync`, `startAegisDeviceInbox` passent dans le runner conditionnel.

`src/hooks/useDeviceRegistration.ts`
- Couper la fonction en deux phases : phase A (credential check + enrôlement + attente d'approbation, autorisée dès `DEVICE_CREDENTIAL_CHECK`) et phase B (SPK/OPK, `mark_current_device_route_ready`, `ensureApprovedDeviceTrust`, `beginAccountSynchronization`, `syncAegisDeviceInbox`) qui n'est exécutée que si `pinUnlocked` est vrai ; sinon on s'arrête à `APPROVED_LOCKED` et la phase B est relancée sur l'événement de déverrouillage PIN.
- Le polling d'approbation (`APPROVAL_POLL_MS`) reste, il ne touche aucun secret.

### 6. Suppression du flow « PIN-first » et des rotations silencieuses

- `src/hooks/useDeviceRegistration.ts` : supprimer `restartWithFreshServerDevice()` et tous ses appels. Les cas correspondants deviennent `markRouteUnavailable(...)` + passage en `LINK_REQUIRED` (état contrôlé, ré-enrôlement uniquement sur action utilisateur). Retirer aussi `rotateCurrentDeviceId('cancelled-server-enrollment')` du bloc `catch`.
- `src/lib/device-manager/currentDevice.ts` : retirer `'aegis-device-private-key-missing'` de `EXPLICIT_ROTATION_REASONS`.
- `src/components/MessagingPinGate.tsx` : le PIN n'est plus le premier écran ; aucun écran de setup PIN ne doit pouvoir s'afficher pour un appareil non approuvé.
- Aucun fichier n'est supprimé ; `useDeviceLink`/QR reste en place, non utilisé par le chemin V1.

## Tests de non-régression indispensables

1. `deviceLifecycleMachine.test.ts` : ordre strict, aucune transition sautée, PIN jamais atteignable depuis `PENDING_APPROVAL`/`LINK_REQUIRED`.
2. `currentDeviceStates.test.ts` : `peekCurrentDeviceId`/`getDeviceIdStatus` ne lèvent jamais ; `rotateCurrentDeviceId` lève toujours `DEVICE_ID_REAPPROVAL_REQUIRED`.
3. `noSilentDeviceIdGeneration.test.ts` : test statique sur la source de `useDeviceRegistration.ts` — aucune occurrence de `rotateCurrentDeviceId` / `beginExplicitDeviceEnrollment` dans un bloc `catch`.
4. `runtimeGating.test.ts` : `canRunCryptoRuntime` faux pour tous les états < `PIN_UNLOCK` ; la phase B de l'enrôlement n'appelle ni `beginAccountSynchronization` ni `syncAegisDeviceInbox` sans PIN.
5. `selfApprovalPolicy.test.ts` : auto-approbation acceptée uniquement sans autre appareil approuvé actif ; refusée sinon ; preuve de possession toujours exigée.
6. `MessagingPinGate` : rendu `DeviceApprovalGate` pour `PENDING_APPROVAL`, PIN uniquement à partir de `APPROVED_LOCKED`.
7. Conserver verts les tests existants `stableDeviceIdentityArchitecture`, `deviceEnrollmentGate`, `deviceRegistryTrust/FailClosed`, `multiDeviceFanoutSecurity`, `accountSyncBarrier`.

## Points à confirmer

- L'auto-approbation V1 doit-elle rester limitée au cas « aucun autre appareil approuvé » (recommandé) ou être permise même quand un autre appareil approuvé existe ?
- Le changement côté Edge Function implique un déploiement : je ne le fais qu'après votre accord explicite.
