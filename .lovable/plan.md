# L1 + L3 + L2 + L5 — Durcissement E2EE (parité Signal/WhatsApp)

Quatre chantiers crypto majeurs, livrés en séquence pour limiter le risque de régression sur la messagerie.

## L1 — Double Ratchet rev.4 conformité

**Header Encryption (HE variant)**
- Nouveau module `src/lib/crypto/headerEncryption.ts` : chiffre `{DH_pub, N, PN}` avec une `HK`/`NHK` dérivée de la root chain (HKDF info `"WhisperHeader"`).
- Wire format v6 (`x3dh6.`) : `[encHeader || ciphertext || tag]`. Les pairs legacy v5 restent lus via le router existant.
- `doubleRatchet.ts` : ajout `encryptHeader/decryptHeader`, fallback try-current-then-next-HK.

**MAX_SKIP strict**
- Constante `MAX_SKIP = 1000` dans `constants.ts` ; refus dur au-delà (throw `RatchetSkipOverflow`).
- TTL 24 h sur les skipped keys (déjà partiel via A3) → purge au démarrage + cron client.

**AAD audit**
- Vérif que `AAD = AD || serializedHeader` partout (router legacy + nouveau). Tests vecteurs.

**Tests**
- `__tests__/headerEncryption.test.ts` : aller-retour HE, rotation NHK.
- Property-based out-of-order jusqu'à 999 messages, rejet à 1001.

## L3 — PQXDH durci

**Last-resort PQ prekey**
- Migration : colonne `is_last_resort boolean` sur `pqkem_prekeys` (déjà fait pour SPK classique → étendre).
- `x3dh.ts` : si pool PQ vide, claim la last-resort sans la consommer.
- Republication PQ-SPK signée Ed25519 (déjà signée → vérifier la signature côté receveur en strict mode).

**Replay cache PQXDH**
- Migration `pqxdh_replay_cache(user_id, init_hash, expires_at)` TTL 7j.
- RPC `claim_pqxdh_initial(hash)` : INSERT-OR-FAIL → rejette les replays de bundle initial complet (`IK_A || EK_A || PQKEM_ct`).

## L2 — Sender Keys câblage groupes

**Pipeline d'envoi**
- `secureMessagePipeline.ts` : si `conversation.kind === 'group'` ET `members.length > 2` ET tous les devices supportent SK → route via `senderKeySession.encrypt()` au lieu du fan-out pairwise.
- Wire format `sk1.` (déjà défini).

**Distribution Message (SKDM)**
- À l'init de session ou rotation : envoie le `SenderKeyDistributionMessage` chiffré pairwise (Double Ratchet) à chaque membre via `multiDeviceFanout`.

**Rotation auto**
- Trigger sur events DB `conversation_members` (INSERT/DELETE) → realtime channel → `senderKeySession.rotate()` côté chaque membre owner.
- Hook `useGroups` écoute et déclenche.

**Decrypt**
- `legacyDecryptRouter.ts` : route les `sk1.` vers `senderKeyInbound.decrypt()`.

**Feature flag**
- `localStorage['forsure-sk-groups'] = '1'` pour activer progressivement (default OFF semaine 1, ON semaine 2 après monitoring).

## L5 — Backup PIN style WhatsApp E2E

**UX onboarding**
- Nouveau dialog `BackupPinSetupDialog` dans Réglages → Sécurité → "Sauvegarde par PIN".
- Demande PIN 6 chiffres + confirmation. Avertissement : "Si oublié, messages perdus définitivement".

**Edge function `e2e-backup-hsm`**
- `POST /derive` : reçoit `{userId, pin, salt, attempt_id}`. Dérive `BackupKey = HKDF(PBKDF2(pin, salt, 600k))` côté serveur **sans stocker le PIN**.
- Rate-limit : 10 tentatives par compte par 24 h. Lockout 24 h. Compteur stocké en DB (`backup_pin_attempts`).
- Le serveur renvoie le `BackupKey` dérivé seulement si rate-limit OK. Le client l'utilise pour déchiffrer la `MasterKey` chiffrée déjà en backup.

**Migration**
- `backup_pin_state(user_id PK, salt bytea, pin_wrap_master bytea, attempts_count int, locked_until timestamptz, created_at, updated_at)`.
- RLS : user lit/écrit la sienne uniquement.

**Restoration flow**
- Tab supplémentaire dans `E2EERestorePromptDialog` : "PIN" (à côté de Mot de passe / Clé de récupération).
- Appelle `e2e-backup-hsm/derive`, affiche compteur essais restants.

## Détails techniques

```
src/lib/crypto/
├── headerEncryption.ts       NEW (L1)
├── constants.ts              MAX_SKIP=1000 (L1)
├── doubleRatchet.ts          HE wiring (L1)
├── x3dh.ts                   last-resort + replay (L3)
├── x3dhReplayGuard.ts        étendu (L3)
├── pinBackup.ts              NEW (L5)
└── senderKeys/
    └── pipelineRouter.ts     NEW (L2 — décide SK vs pairwise)

src/lib/messaging/
├── secureMessagePipeline.ts  branche SK (L2)
└── multiDeviceFanout.ts      skip si SK actif (L2)

src/components/messages/
├── E2EERestorePromptDialog.tsx  +tab PIN (L5)
└── BackupPinSetupDialog.tsx     NEW (L5)

supabase/functions/
├── e2e-backup-hsm/index.ts   NEW (L5)
└── kt-publish-epoch          (existant, pas touché)

migrations:
- pqxdh_replay_cache (L3)
- pqkem_prekeys.is_last_resort (L3)
- backup_pin_state (L5)
```

## Découpage de livraison

1. **L1 d'abord** (zéro impact UX, durcissement pur). Vecteurs de test avant déploiement.
2. **L3 ensuite** (faible risque, 1 migration + 1 RPC).
3. **L2** (risque moyen — pipeline d'envoi). Feature flag obligatoire, rollout progressif.
4. **L5 en dernier** (UX onboarding + edge function HSM). Optionnel pour l'utilisateur.

Compatibilité legacy v5 préservée pendant toute la transition. Aucun message existant ne devient illisible.

## Hors-scope

- L4 (multi-device signed list) : déjà partiellement en place via mémoire `signed-device-list`.
- L6 (Key Transparency Merkle) : déjà en place via mémoire `key-transparency-merkle`.
- L7 (vecteurs interop officiels libsignal) : à faire dans un lot dédié plus tard.

Confirme pour que j'attaque **L1** en premier (header encryption + MAX_SKIP), je livre, on teste, puis on enchaîne.
