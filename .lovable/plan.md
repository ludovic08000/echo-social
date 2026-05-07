# Audit ForSure vs WhatsApp — Mai 2026

Sources consultées : Signal X3DH spec (signal.org), WhatsApp Security Whitepaper (v3 2023, contenu connu — 403 sur fetch direct), docs FAQ WhatsApp (mémoire). Comparaison ciblée sur 4 axes demandés.

Légende : ✅ couvert · ⚠️ partiel · ❌ manquant · 🔒 sécurité · 🆕 ajout proposé

---

## 1) Messagerie E2EE (protocole Signal)

| Capacité WhatsApp | État ForSure | Action |
|---|---|---|
| X3DH (IK, SPK signé, OPK pool) | ✅ `src/lib/crypto/x3dh.ts` + OPK pool 100/seuil 25 | — |
| Double Ratchet (DH + chaîne sym) | ✅ `ratchet.ts`, `kdfChain.ts`, `deviceRatchet.ts` | — |
| PQXDH (post-quantique Kyber) | ⚠️ référencé mais pas activé par défaut | 🆕 P2 : activer hybrid X25519+ML-KEM-768 |
| Sealed Sender (cache l'expéditeur au serveur) | ✅ `sealedSender.ts` + `senderCertificate.ts` | — |
| Multi-device (per-device session) | ✅ `deviceKx.ts`, `deviceWrap.ts`, manifest | — |
| Safety Numbers / QR de vérif | ✅ `SafetyNumberDialog.tsx` | — |
| Rotation SPK (semaines) | ✅ 7j (mémoire) | — |
| Sender Keys pour groupes (1 chiffrement, N envois) | ❌ aujourd'hui = fanout par device | 🆕 P1 : `senderKeys.ts` (groupes >5) |
| Session reset auto en cas de mismatch | ✅ `sessionInvalidation.ts`, `resyncE2EE.ts` | — |
| Disappearing messages (24h/7j/90j) | ❌ | 🆕 P1 : flag `expires_at` + purge edge cron |
| View Once (texte+média) | ❌ | 🆕 P2 : champ `view_once`, suppression au 1er déchiffrement réussi |
| Edit message (15 min) | ❌ | 🆕 P3 : `message_edits` + UI |
| Réactions emoji (envoi chiffré) | ⚠️ réactions feed OK, pas en chat E2EE | 🆕 P2 |
| Messages cités / réponse contextuelle | ⚠️ partiel | 🆕 P3 : preview chiffré inline |
| Forward limit + label "Forwarded" | ⚠️ Forward dialog présent, pas de label | 🆕 P3 |
| Read receipts chiffrés (option) | ⚠️ statut envoyé/lu présent | ⚠️ vérifier toggle global |
| Receipts de livraison (✓✓) | ✅ `OutboundStatus.tsx` | — |
| Backups chiffrés (clé 64 chars / mdp) | ✅ `accountKeyBackup.ts` + QR | — |

🔒 Risques détectés :
- `legacyDecryptRouter.ts` garde une voie de fallback DeviceWrap — conserver derrière feature flag avec date d'expiration.
- Aucun **MAC global d'envelope** détecté à la lecture rapide → vérifier `v4Envelope.ts` couvre bien l'AAD.

---

## 2) Médias chat (vocaux, photos, vidéos, docs)

| Capacité WhatsApp | État ForSure | Action |
|---|---|---|
| Chiffrement E2EE des médias (clé par msg) | ✅ `mediaEncrypt.ts`, `EncryptedMedia.tsx` | — |
| Stockage chiffré côté serveur (R2) | ✅ Cloudflare R2 hybride | — |
| Compression image (WebP) avant chiffrement | ✅ `imageOptimize.ts` | — |
| Compression vidéo (h264 preset) | ❌ envoi brut | 🆕 P2 : ffmpeg.wasm preset chat (≤480p, CRF 28) |
| Miniatures chiffrées séparées | ⚠️ image only | 🆕 P3 : thumbnail vidéo chiffré |
| Voice notes (Opus, waveform) | ✅ `VoiceRecordButton.tsx` (mémoire iOS audio/x-caf) | ⚠️ ajouter waveform pré-calculée |
| Lecture vocale 1×/1.5×/2× | ❌ | 🆕 P2 : contrôle vitesse |
| Transcription vocale (locale ou Zeus) | ❌ | 🆕 P2 : Zeus speech-to-text on-demand |
| Documents (PDF, etc.) | ⚠️ pas de path explicite | 🆕 P2 : type `document`, preview PDF |
| Albums (multi-images en 1 message) | ❌ | 🆕 P3 |
| GIFs (Tenor/Giphy) | ✅ déjà CSP'd | — |
| Stickers + packs | ❌ | 🆕 P3 |
| View Once média | ❌ | 🆕 P2 (cf. ci-dessus) |

🔒 : Le `VoiceRecordButton` désactive la validation MIME pour iOS (`audio/x-caf`) — déjà mémorisé. OK.

---

## 3) Appels audio/vidéo (1:1 + groupe)

| Capacité WhatsApp | État ForSure | Action |
|---|---|---|
| Appel 1:1 audio + vidéo E2EE (DTLS-SRTP) | ⚠️ LiveKit WebRTC + `callKeyEncrypt.ts` AES-256-GCM/X25519 | ⚠️ vérifier que la clé n'arrive **jamais** au serveur LiveKit en clair |
| Sonnerie / `IncomingCallOverlay` | ✅ | — |
| `active_calls` table + signaling | ✅ (mémoire) | — |
| Appels groupe (≤32 WA) | ⚠️ LiveKit room scalable | 🆕 P2 : UI grille participants + mute/raise hand |
| Indicateur qualité réseau | ❌ | 🆕 P2 : RTCStats → badge |
| Réactions emoji en appel (WA récent) | ❌ | 🆕 P3 |
| Partage d'écran | ❌ | 🆕 P2 (LiveKit support natif) |
| Effets / blur fond | ❌ | 🆕 P3 (mediapipe) |
| Picture-in-picture mobile | ❌ | 🆕 P3 |
| Historique appels manqués + rappel | ⚠️ overlay seulement | 🆕 P2 : page "Appels" |
| Lien d'appel (call link) | ❌ | 🆕 P3 |

🔒 : Audit à faire : `livekit.ts` doit utiliser **token éphémère** + `e2ee` LiveKit (DataChannel chiffré côté client) pour vraie E2EE multi-party.

---

## 4) Statuts / Stories + Communautés

| Capacité WhatsApp | État ForSure | Action |
|---|---|---|
| Stories TTL 24h | ✅ `StoriesBar.tsx` (mémoire stories-system) | ⚠️ confirmer purge edge fn |
| Vues (qui a vu) | ⚠️ à vérifier | 🆕 P2 |
| Réactions emoji story | ⚠️ existe sur feed, pas certain stories | 🆕 P2 |
| Mentions dans story → DM | ❌ | 🆕 P3 |
| Audience (privacy : amis/exclus) | ⚠️ Anonymous Wall a settings, stories ? | 🆕 P2 : cible par groupe d'amis |
| Statuts texte (fond couleur) | ❌ | 🆕 P3 |
| Communautés (parent + sous-groupes) | ❌ | 🆕 P3 lourd |
| Annonces communauté (broadcast read-only) | ❌ | 🆕 P3 |
| Sondages dans groupes | ❌ | 🆕 P2 |
| Événements communauté | ❌ | 🆕 P3 |

---

## Lots de réparations / ajouts priorisés

### Lot A — Quick wins (1 session)
- A1 : **Disappearing messages** côté chat (DB + UI + purge cron)
- A2 : **Lecture vocale variable** (1×/1.5×/2×) + waveform locale
- A3 : **Indicateur qualité réseau** en appel (RTCStats → badge)
- A4 : Confirmer/raccorder **purge stories 24h** côté edge function

### Lot B — Sécurité E2EE (1 session dédiée)
- B1 : **Sender Keys** pour groupes (perf énorme >5 destinataires)
- B2 : Audit + activation **PQXDH hybrid** (Kyber768)
- B3 : Vérification AAD complète sur `v4Envelope`
- B4 : Plan d'extinction `legacyDecryptRouter` (date butoir)

### Lot C — Médias (1 session)
- C1 : **Compression vidéo chat** ffmpeg.wasm (480p/CRF28)
- C2 : **View Once** (texte+média) avec suppression atomique
- C3 : **Documents** (PDF preview chiffré)
- C4 : **Transcription vocale** Zeus on-demand (Creator)

### Lot D — Appels (1 session)
- D1 : Activation **LiveKit E2EE** multi-party (DataChannel + frame crypto)
- D2 : **Page "Appels"** (historique manqués/passés)
- D3 : **Partage d'écran** + UI grille groupe

### Lot E — Stories/Communautés (à étaler)
- E1 : **Vues + réactions stories**
- E2 : **Audience privacy stories** (par groupe d'amis)
- E3 : **Sondages** dans conv groupe
- E4 : **Communautés** (parent group + sous-groupes + annonces) — gros chantier

---

## Recommandation d'ordre
1. **Lot A** maintenant (impact immédiat, peu de risque)
2. **Lot B** ensuite (priorité sécurité)
3. **Lot C** puis **Lot D** (richesse fonctionnelle)
4. **Lot E** en chantier long

---

## Lot B — résultats (mai 2026)

### B1 — Sender Keys (foundation) ✅
- DB: `sender_key_state` (chain key + ECDSA P-256 signing key par sender device), `sender_key_distribution` (SKDM ratchetés pairwise par recipient device), flag `conversations.enable_sender_keys` (opt-in).
- Crypto: `src/lib/crypto/senderKeys.ts` — `generateSenderKey`, `deriveStep` (HKDF-SHA256 chain/msg), `senderKeyEncrypt/Decrypt` (AES-256-GCM + AAD `conv|sender|iter`, signature ECDSA sur header+CT), `buildSKDM/parseSKDM`. Wire format: `sk1.<conv>.<senderDev>.<iter>.<sigPub>.<iv>.<ct>.<sig>`.
- **Pas encore branché** dans le pipeline d'envoi : à câbler quand on basculera un groupe pilote (>5 membres).

### B3 — Audit AAD (audit-only, pas de patch) 📋
État actuel `v4Envelope` / `ratchetEncrypt` :
- AES-GCM est utilisé **sans `additionalData`** explicite. Les champs `Ns`, `PN`, `dhPubB64`, `sessionId` sont dans le préfixe wire mais PAS dans le tag GCM.
- **Impact** : un attaquant qui modifierait `Ns` ou `dhPubB64` provoquerait un tag mismatch implicite (la dérivation de la clé message dépend du sessionId+Ns côté récepteur via le chain skip → mauvaise mk → tag invalide). Donc la sécurité est implicite, pas explicite.
- **Risque** : si un futur refactor change la dérivation, on perd la protection silencieusement. Pas de CVE aujourd'hui.
- **Migration future** (non faite) : préfixe `x3dh5` avec `additionalData = sessionId|Ns|PN|dhPubB64`. Lecture v4 conservée. À planifier quand stable.

### B4 — Kill-switch legacy router ✅
- Compteurs par décodeur (`ratchet-v4`, `ratchet-v3`, `legacy-router`) avec mirror localStorage `e2ee.legacyRouter.hits` lisible par le SOC dashboard.
- Constante `LEGACY_ROUTER_EXTINCTION_DATE = '2026-09-01'`. Helpers : `legacyRouterStats()`, `isLegacyRouterExtinct()`.
- Règle : 30 jours consécutifs sans hit `v3`/`legacy-router` après extinction date → on retire les décodeurs.
