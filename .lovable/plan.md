# Alignement E2EE sur Signal & WhatsApp (parité protocole)

Objectif : amener le système au niveau **Signal Protocol** (X3DH + Double Ratchet + PQXDH + Sender Keys) et **WhatsApp Whitepaper v9** (multi-device, key transparency, E2E backup).

Sources de vérité :
- Signal X3DH : https://signal.org/docs/specifications/x3dh/
- Signal Double Ratchet rev.4 (2025-11-04) : https://signal.org/docs/specifications/doubleratchet/
- Signal PQXDH rev.3 : https://signal.org/docs/specifications/pqxdh/
- WhatsApp Encryption Whitepaper v9 (2026-02-25)
- WhatsApp Key Transparency v1
- WhatsApp E2E Backup (HSM-backed)

## État actuel (forces déjà en place)

- X3DH + Double Ratchet + PQXDH (mémoire `encryption-protocol`)
- Sender Keys foundation (DB prête, opt-in, pas câblée — mémoire `sender-keys-foundation`)
- DeviceWrap per-device KX (mémoire `devicewrap-per-device-kx`)
- Backup chiffré + recovery key (mémoire `key-sync-backup`)
- Safety numbers + QR (mémoire `safety-verification`)
- Purge clés sur blur/idle, IDB hardening (mémoire `local-key-hardening`)

## Écarts vs spec (à combler)

### Bloc A — Conformité Double Ratchet rev.4
1. **Header encryption (HE variant)** : section 4 de la spec — chiffrer les headers (DH pub, N, PN) avec une clé dérivée de la root. Empêche le serveur de corréler conversations. *(actuellement headers en clair)*
2. **MAX_SKIP** strict + purge des skipped message keys après N messages / TTL (section 2.6). Vérifier que `MKSKIPPED` n'est pas illimité.
3. **AEAD AAD = AD || header** correctement (section 3.4). Auditer le câblage AAD côté router legacy + nouveau router.
4. **KDF chains** : confirmer HKDF-SHA256 avec les info-strings exacts ("WhisperRatchet", "WhisperMessageKeys") — interop Signal.

### Bloc B — PQXDH durci
5. **Last-resort PQ prekey** + signature Ed25519 sur la PQ-SPK (section 3.2 PQXDH). Vérifier qu'on republie une PQ-SPK non utilisée.
6. **Replay protection** par enregistrement du `IK_A || EK_A || PQKEM` côté receveur pendant la fenêtre de validité (section 4.4).

### Bloc C — Sender Keys (groupes) — CÂBLAGE
7. Activer l'envoi via Sender Keys pour les conversations de groupe (>2 membres) — actuellement opt-in non câblé.
8. **Distribution Message** chiffré pairwise via Double Ratchet à chaque membre (Whitepaper §"Group Messages").
9. Rotation Sender Key sur chaque `member-leave` / `device-add` (forward secrecy groupe).
10. Chain key ratchet symétrique par message (HMAC-SHA256), signature ECDSA-P256 par message — déjà en place, valider conformité bit-à-bit avec la PoC `WhatsUpp with Sender Keys` (eprint 2023/1385).

### Bloc D — Multi-device façon WhatsApp v9
11. **Companion devices** : chaque device a sa propre identity, signée par l'identity du device principal (chain de signatures). Aujourd'hui DeviceWrap utilise per-device KX mais pas de chain de signatures.
12. **Device list signing** : publier `{deviceId, identityPub, addedAt}[]` signé par le device principal → vérifié par les pairs lors de chaque session init.
13. **App-state sync** chiffré (paramètres, contacts bloqués, étoilés) entre devices via une clé dérivée master-key.

### Bloc E — Key Transparency (WhatsApp KT v1)
14. Publier les bundles publics dans un **arbre Merkle append-only** signé périodiquement (auditable).
15. Endpoint `/key-audit/:userId` retournant la preuve d'inclusion + l'historique des fingerprints.
16. UI "Vérifier l'historique des clés" dans Sécurité du chat.

### Bloc F — Backup E2E façon WhatsApp (HSM-backed)
17. Mode "Backup chiffré bout-en-bout" alternatif à la recovery key 64 hex : **PIN 6+ chiffres**, dérivation côté **HSM virtuel** (edge function avec rate-limit strict + lockout après 10 essais), 2^N essais max — Whitepaper E2E Backup §3.
18. Stocker uniquement le `BackupKey` chiffré par une clé HSM ; le PIN n'est jamais exposé au serveur applicatif.

### Bloc G — Tests interop & vecteurs
19. Ajouter vecteurs de test officiels Signal (libsignal test vectors) à `interopV4V5.test.ts`.
20. Test cross-platform : message envoyé depuis device A (header-encrypted) → reçu par device B legacy → fallback gracieux.
21. Property-based tests (fast-check) sur l'ordre out-of-order jusqu'à MAX_SKIP=1000.

## Détails techniques

```text
src/lib/crypto/
├── doubleRatchet.ts          → ajouter mode HE (header encryption)
├── x3dh.ts                   → enforce last-resort PQ-SPK + replay cache
├── senderKeys/
│   ├── distribute.ts         → CÂBLER (aujourd'hui dormant)
│   └── rotate.ts             → trigger sur member-change
├── multiDevice/
│   ├── deviceList.ts         → signed list + verify chain
│   └── appStateSync.ts       → NEW
├── keyTransparency/
│   ├── merkle.ts             → NEW (append-only log client side)
│   └── audit.ts              → NEW
└── backup/
    └── hsmBackup.ts          → NEW (PIN-based via edge fn)

supabase/functions/
├── key-transparency-publish/ → NEW (sign Merkle root quotidien)
├── key-transparency-prove/   → NEW (preuve d'inclusion)
└── e2e-backup-hsm/           → NEW (rate-limit 10 essais, dérivation côté serveur sans connaître le PIN clair)

migrations/
├── key_transparency_log (id, root_hash, signed_at, signature)
├── user_device_signatures (device_id, parent_device_id, signature, added_at)
└── pqxdh_replay_cache (user_id, hash, expires_at)
```

## Découpage en lots livrables

| Lot | Contenu | Risque |
|-----|---------|--------|
| **L1** | Bloc A (Double Ratchet rev.4 conformité + AAD audit + MAX_SKIP) | Faible — durcissement |
| **L2** | Bloc C (Sender Keys câblage groupes) | Moyen — touche pipeline d'envoi |
| **L3** | Bloc B (PQXDH last-resort + replay cache) | Faible |
| **L4** | Bloc D (Multi-device signed list) | Moyen — nécessite migration |
| **L5** | Bloc F (Backup HSM-style avec PIN) | Moyen — UX onboarding |
| **L6** | Bloc E (Key Transparency Merkle) | Élevé — infra cron + UI audit |
| **L7** | Bloc G (vecteurs interop officiels) | Faible — tests uniquement |

## Recommandation

Commencer par **L1 + L3** (durcissement protocole pur, zéro impact UX) puis **L2** (Sender Keys déjà préparés en DB → ROI immédiat sur les groupes). Les lots L4-L6 demandent plus de travail UX/infra et méritent chacun leur propre validation.

## Hors-scope (à valider)

- Migration vers `libsignal-client` WASM officiel (Rust → WASM) : remplacerait notre implémentation maison. Décision stratégique : interop parfaite mais bundle +800 KB et perte du contrôle fin sur le purge mémoire.
- MLS (RFC 9420) pour les groupes >256 membres — alternative aux Sender Keys.

Confirme par quel lot commencer (recommandation : L1 + L3 ensemble), ou si tu veux que j'attaque tout en séquence.