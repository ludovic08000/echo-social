
# Audit recovery E2EE & plan d'alignement Signal

## 1. Ce qui existe déjà (✅ bon socle)

| Brique | Statut | Fichier |
|---|---|---|
| Master Key v5 (PBKDF2 600k, dual wrap password + recovery key) | ✅ live | `accountKeyBackup.ts` + `useAccountKeySync.ts` |
| PIN L5 WhatsApp-style (rate-limit serveur 10/24h) | ✅ live | `pinWrap.ts` + RPC `release_backup_pin_blob` |
| Recovery key 64-hex single-use | ✅ live | `recoveryKey.ts` |
| Passkey / WebAuthn vault | ✅ live | `passkeyVault.ts` |
| RecoveryManager (router 3 sources) | ✅ live | `recoveryManager.ts` |
| Signed Device List (L4, Ed25519) | ✅ live | `signedDeviceList.ts` |
| Trust-gated fanout (A1) | ✅ live | `deviceRegistry.ts` |
| Identity-change ledger + TOFU banner (A4) | ✅ live | `identityChangeLedger.ts` |
| Key Transparency Merkle (L6) | ✅ live | `ktMerkle.ts` + cron |
| `senderKeySession` orchestrateur | ⚠️ écrit, **pas câblé** | `senderKeySession.ts` |
| `keys_epoch` + `request_message_refanout` (DB) | ⚠️ migration appliquée, **aucun client n'appelle** | RPC SQL |

## 2. Gaps identifiés par scénario

### A. Réinstall / cache wipe iOS (même device, IDB vide)
- `useAccountKeySync` détecte mais le **TOFU banner ne distingue pas** « recovery » d'un vrai changement d'identité → contacts paniquent.
- Après restore, **pas de force-pull** des `bump_device_keys_epoch` côté contacts → ils continuent d'utiliser le bundle en cache.
- `request_message_refanout` **jamais appelée** quand un message arrive avec `decrypt failure` post-restore.

### B. Nouveau device (linking style Sesame)
- `devicePairing.ts` existe mais **pas de SKDM auto** envoyé aux groupes auxquels le nouveau device participe.
- Pas de **re-signature de la device list** atomique après ajout (fenêtre rogue-device).
- Pas de pull historique chiffré (le device 2 voit chat vide jusqu'au prochain message).

### C. Perte totale (PIN/recovery uniquement)
- Restore fonctionne mais **pas de nouvel epoch publié** ni de notif explicite « j'ai restauré sur un nouveau téléphone » aux contacts.
- Pas d'alignement SVR2 : `release_backup_pin_blob` est bien rate-limité mais **pas de attestation** ni de tentative-counter visible UX.
- Sender keys du user → **pas rotées** après restore (les groupes restent sur l'ancien SK que le user ne peut plus déchiffrer entrant).

## 3. Plan priorisé (4 lots, livrables indépendants)

### Lot 1 — Câbler `keys_epoch` + re-fanout (1 migration déjà OK, code client manquant)
1. **`x3dh.ts` / `peerKeyCache`** : stocker `keys_epoch` dans le cache bundle ; invalider quand mismatch.
2. **`accountKeyBackup.restoreFromMasterKey`** : appeler `bump_device_keys_epoch` à la fin du restore.
3. **`messageRouter` / `fallbackDecrypt`** : sur échec de déchiffrement persistent (>2 tentatives), appeler `request_message_refanout` au lieu d'abandonner.
4. **`useAccountKeySync` polling** : ajouter watch realtime sur `device_signed_prekeys.keys_epoch` des contacts → purger `peerKeyCache` ciblé.

### Lot 2 — SVR2-like hardening du PIN
1. Exposer dans UI Settings un compteur « tentatives restantes avant lockout 24h » (lecture depuis RPC).
2. Ajouter **attestation HMAC** côté edge function pour empêcher replay du blob (`pinWrap` → bind à `user_id + device_id + epoch`).
3. UX : écran dédié « Restaurer avec PIN » avec backoff visuel (Signal SVR2 style).
4. Optionnel : seconde sauvegarde derivée pour secret-sharing 2-of-3 si user le veut.

### Lot 3 — Sesame device-linking complet
1. Câbler `senderKeySession` dans `e2ee.ts` pipeline d'envoi (déjà tracké dans memory `sender-key-session-orchestrator`).
2. À l'ajout d'un device via `devicePairing` :
   - Re-signer atomiquement la device list (transaction).
   - Pour chaque conversation de groupe : envoyer un **SKDM** au nouveau device + déclencher rotation SK (`maybeAutoRotate` forcé).
   - Backfill : appeler `request_message_refanout` sur les N derniers messages de chaque thread du nouveau device.
3. Ajouter `devicePairingProgress` event → UI shows « Synchronisation… 12/47 conversations ».

### Lot 4 — TOFU recovery-aware + sender keys post-restore
1. Étendre `identityChangeLedger` avec un type `recovery_restore` distinct de `key_change`.
2. `IdentityChangeBanner` : copy spécifique « Marie a restauré son compte sur un nouvel appareil » (rassurant, pas alarmant) avec lien vers Safety Number.
3. **`senderKeyRotationWatcher`** : déclencher rotation forcée sur **tous** les groupes de l'user après restore (pas seulement membership change).
4. Auto-fast-forward decrypt sur messages reçus pendant la fenêtre de restore (utiliser `request_message_refanout` + nouveau SKDM).

## 4. Détails techniques transverses

- **Aucune nouvelle migration DB requise** : `keys_epoch` + `request_message_refanout` + `bump_device_keys_epoch` + `get_device_prekey_bundle` sont déjà déployés et validés.
- **Edge functions à créer/modifier** :
  - `pin-backup-release` (existante) → ajouter attestation HMAC.
  - `device-link-progress` (nouvelle) → orchestrer SKDM + refanout en lot pour pas saturer le client.
- **Tests à ajouter** :
  - `accountKeyBackup.restore.test.ts` : vérifier `bump_device_keys_epoch` appelé.
  - `messageRouter.refanout.test.ts` : vérifier déclenchement après 3 échecs.
  - `devicePairing.fanout.test.ts` : vérifier SKDM envoyé + device list re-signée.
- **Mémoire à mettre à jour** après chaque lot livré (`features/messaging/silent-recovery-ux`, `tech/messaging/encryption-protocol`).

## 5. Ordre d'exécution recommandé

```text
Lot 1 (cablage epoch+refanout) ──► quick win, débloque la chaîne
   └─► Lot 4 (TOFU + SK rotation post-restore) ──► UX confiance
         └─► Lot 3 (Sesame complet) ──► gros chantier, dépend de Lot 1
               └─► Lot 2 (SVR2 hardening) ──► polish sécurité
```

Lot 1 + 4 = 80% de la valeur perçue utilisateur en quelques itérations. Lot 3 est le plus gros (touche pipeline d'envoi). Lot 2 est polish.

---

**Question avant de coder** : on attaque **Lot 1** en premier (câblage `keys_epoch` + `request_message_refanout`) ? C'est le pré-requis de tout le reste et c'est ~3 fichiers à toucher.
