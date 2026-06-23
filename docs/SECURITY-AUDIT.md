# Audit de chiffrement — echo-social

**Périmètre** : messagerie chiffrée de bout en bout (`src/lib/crypto/**`, `src/lib/messaging/**`, `src/hooks/useE2EE.ts`, policies `supabase/migrations/**`).
**Référence** : *WhatsApp Encryption Overview – Technical White Paper* (Meta, v3, oct. 2020) + spécifications Signal (X3DH, Double Ratchet, Sender Keys).
**Type d'intervention** : audit **lecture seule**. Aucun code n'a été modifié. Les références sont au format `fichier:ligne`.

> ⚠️ Cet audit est une revue de logique/architecture, pas une preuve formelle ni un pentest. Il ne remplace pas une revue par un cryptographe et des tests d'intégration côté serveur (RLS, accès service-role).

---

## Synthèse

L'implémentation **pairwise** (1-à-1) est de bonne facture et **conforme** à Signal/WhatsApp : X3DH (X25519/Ed25519), Double Ratchet (DH + chaîne symétrique HMAC), AES-256-GCM, HKDF-SHA-256, padding de longueur, replay-guard X3DH, prekeys signées et OPK à usage unique.

En revanche, la couche **groupes (Sender Keys)** et la couche **sealed sender / multi-device** présentent des défauts **graves** qui annulent en pratique le E2EE pour les conversations de groupe, et plusieurs faiblesses d'authentification.

| Sévérité | Nombre |
|----------|--------|
| 🔴 Critique | 1 |
| 🟠 Élevée | 4 |
| 🟡 Moyenne | 6 |
| ⚪ Faible / hygiène | 5 |

---

## 🔴 Critique

### C1 — Les clés de chaîne Sender Key (et la clé privée de signature) sont stockées en clair sur le serveur
**Fichiers** : `senderKeySession.ts:80-94` (`saveOwnerState`), `senderKeySession.ts:120-134` (`saveRecipientState`) ; table `supabase/migrations/20260507100630_*.sql:10,13` ; RLS `:24-29`.

`saveOwnerState`/`saveRecipientState` font un `supabase.from('sender_key_state').upsert({ chain_key_b64, signing_priv_jwk, ... })`. La colonne `chain_key_b64` (clé de chaîne 32 octets) est persistée **en clair** côté serveur, et `signing_priv_jwk` (clé **privée** de signature du propriétaire) aussi.

Or `deriveStep()` (`senderKeys.ts:60-90`) dérive toutes les clés de message par `HKDF(chain_key, info=msg)`. Donc :

- **Confidentialité brisée** : quiconque lit la table (le serveur lui-même, le rôle `service_role`, ou une fuite de base) peut dériver **toutes** les clés de message et **déchiffrer tous les messages de groupe**. La RLS SELECT (`:28`) autorise même tout participant à lire les lignes miroir (`NOT is_owner`).
- **Authenticité brisée** : avec `signing_priv_jwk`, le serveur peut **forger** des messages au nom de n'importe quel membre. La migration `20260608061821_*.sql:34` révoque seulement le `SELECT` *client* sur cette colonne — la donnée reste présente en base et lisible par le serveur.

Tout le soin pris à distribuer le SKDM via le ratchet pairwise chiffré est **annulé** dès que la clé est ré-uploadée en clair.

**Écart doc Meta** : chez WhatsApp, l'état Sender Key vit **uniquement sur les appareils** des membres ; le serveur ne relaie que le SKDM chiffré pairwise. Aucune clé symétrique ni privée ne transite ni n'est stockée côté serveur.

**Piste (non appliquée)** : ne jamais persister `chain_key_b64`/`signing_priv_jwk` côté serveur ; stocker l'état Sender Key uniquement en local (IndexedDB, éventuellement wrappé), comme l'état du Double Ratchet pairwise l'est déjà (`ratchet.ts` serialize → IndexedDB).

---

## 🟠 Élevée

### H1 — La signature par message des groupes n'est pas liée à la clé de l'expéditeur de confiance → forgeable
**Fichiers** : `senderKeys.ts:161-192` (`senderKeyDecrypt`), `senderKeySession.ts:311-349` (`decryptFromGroup`).

`senderKeyDecrypt` vérifie la signature ECDSA en important **la clé publique contenue dans le wire lui-même** (`sigPubB64`, champ 4 du wire) puis vérifie la signature avec cette même clé. Le commentaire `senderKeys.ts:158-159` précise que *l'appelant* doit vérifier que ce `sigPub` correspond à celui stocké dans `sender_key_state` — **mais `decryptFromGroup` ne fait jamais cette comparaison** (`state.signingPubB64` n'est pas utilisé).

Conséquence : la signature est **auto-référentielle** et n'authentifie rien. Quiconque connaît la clé de chaîne (or elle est sur le serveur, cf. C1) peut générer sa propre paire ECDSA, chiffrer, signer avec sa clé privée et insérer sa clé publique dans le wire : la vérification passe. **Aucune protection réelle contre l'injection de messages.**

### H2 — Le SKDM n'est pas authentifié vis-à-vis de l'expéditeur pairwise → usurpation en groupe
**Fichiers** : `senderKeySession.ts:284-300` (`installSKDM`), `senderKeyInbound.ts:43-90` (`processRow`), `senderKeys.ts:255-275` (`parseSKDM`).

Le SKDM transporte `u` (senderUserId) et `d` (senderDeviceId) **dans son plaintext**. `processRow` déchiffre le SKDM via le canal pairwise (authentifié comme `row.sender_user_id`/`row.sender_device_id`) puis appelle `installSKDM(plaintext)` **sans vérifier que `parsed.senderUserId/senderDeviceId == row.sender_user_id/row.sender_device_id`**.

Un membre malveillant peut donc émettre, via son propre canal pairwise authentifié, un SKDM prétendant `u = Alice` avec **sa** clé de chaîne et **sa** clé de signature. Le destinataire écrase son état « Alice » → les messages du malveillant sont **attribués à Alice**.

**Écart doc Meta** : le SKDM doit être indissociablement lié à l'identité de l'expéditeur du canal pairwise qui le transporte.

### H3 — Contournement de la validation du certificat « sealed sender »
**Fichier** : `secureMessagePipeline.ts:104-145` (`validateSenderCertificateShape`).

- `:108` `fetchSenderCertificate(...).catch(() => null)` puis `:109` `if (!latest) return true;` : si le serveur ne renvoie **aucun** certificat (ou si le fetch échoue), la fonction renvoie `true` **sans vérifier la signature**.
- La vérification Ed25519 réelle (`:126-141`) n'est atteinte que si `latest` existe.

Un serveur malveillant (ou une simple erreur réseau) qui supprime/empêche le certificat fait **passer la validation**. L'authentification de l'expéditeur devient optionnelle.

### H4 — Le « sealed sender » ne masque pas l'expéditeur et le journalise côté serveur
**Fichiers** : `sealedSender.ts:1-22`, `secureMessagePipeline.ts:34-76`.

`sealedSender.ts` ne produit qu'un **tag aléatoire** + timestamp : il n'implémente pas le sealed sender de Signal (chiffrer le certificat d'expéditeur à destination du seul destinataire). Pire, `publishSealedSenderTelemetry` (`:34-46`) **écrit côté serveur** (`sealed_sender_events`) le `conversation_id` et le `fingerprint` de l'expéditeur ; le `meta` (`:56-65`) contient `deviceId`/`userId`. La propriété d'anonymat annoncée n'existe pas — le serveur connaît l'expéditeur.

---

## 🟡 Moyenne

### M1 — Downgrade d'AAD au déchiffrement vs « v4 obligatoire » à l'émission
**Fichier** : `ratchet.ts:489-508` (`decryptWithKey`) vs `:289-296`.

À l'émission, le code **refuse** d'émettre sans AAD v4 (header lié). Au déchiffrement, la liste de candidats ajoute **toujours** `null` (sans AAD) en dernier recours (`:493`). La liaison du header (v4 §3.4) et de l'identité (v3) n'est donc **pas imposée** en réception, ce qui contredit la garantie affichée. Impact limité (modifier le header casse généralement la dérivation de clé), mais la promesse « no downgrade » n'est pas tenue.

### M2 — Métadonnées d'enveloppe non authentifiées (`pad`, `v`, `kem`)
**Fichier** : `ratchet.ts:313-319` (signature sur `header|iv|ct|ts` seulement), `:298-303` (AAD = id || header).

`pad`, `v`, `kem` ne sont **ni signés ni dans l'AAD**. Un intermédiaire peut basculer `pad: 1 → 0` : GCM passe (pad hors AAD), signature passe (pad non signé), et le destinataire rend alors le plaintext **paddé brut** → message corrompu. Basculer `v` provoque un échec de déchiffrement (DoS). C'est une lacune d'intégrité sur les métadonnées.

### M3 — Confiance de la liste d'appareils ancrée sur une clé fournie par le serveur
**Fichier** : `signedDeviceList.ts:168-224` (`verifySignedDeviceList`).

La signature d'un companion est vérifiée avec `e.primaryPubB64`, valeur **fournie par le serveur**. Le garde-fou « PRIMARY_PUB_MISMATCH » (`:188`) n'agit que **si une entrée primaire existe** dans la liste : si le serveur omet l'entrée primaire, `primary` est `undefined`, le contrôle est sauté et un companion signé par une clé arbitraire de l'attaquant est accepté. La clé primaire n'est **pas épinglée** à la clé d'identité/signing du compte (celle du safety number). Un serveur malveillant peut fabriquer « primaire + companion ». (`:173` contient aussi du code mort `expectedPrimaryPub = primary ? null : null`.)

### M4 — Anti-rejeu en mémoire, fenêtre 5 min
**Fichier** : `replayGuard.ts:1-52`.

Le cache `seen` est un `Map` **en mémoire**, `WINDOW_MS = 5 min`, réinitialisé à chaque rechargement/onglet. La protection anti-rejeu du pipeline « secure » (`secureMessagePipeline.ts:88-94`) ne couvre donc ni les redémarrages, ni le multi-onglet/multi-appareil, ni les rejeux différés de plus de 5 minutes.

### M5 — Sauvegarde serveur de la Master Key brute-forçable si protégée par mot de passe
**Fichier** : `accountKeyBackup.ts:546-573` (`uploadBackup`), KDF `:34,61-72`.

Le blob `wrapped_master_key` est **uploadé sur Supabase**. PBKDF2-SHA256 à 600 000 itérations est correct, mais pour `backup_type='account'` le secret est un **mot de passe utilisateur** : un mot de passe faible permet un brute-force **hors-ligne** du blob serveur → récupération de la Master Key (donc de tous les messages). Il n'y a pas de coffre matériel à débit limité (type Signal SVR/HSM). Le chemin `recovery` (clé aléatoire à forte entropie) est, lui, sain.

### M6 — Chemin « clé statique » sans forward secrecy
**Fichier** : `e2ee.ts:48-151` (`performKeyExchange`/`encryptMessage`), utilisé par `useIncomingCall.ts:429`.

Ce chemin dérive **une** clé AES par conversation à partir d'un DH X25519 **statique** (identités), réutilisée message après message (compteur `seq`), GCM **sans AAD d'identité**. Aucune PFS, aucun ratchet. À cantonner strictement (p. ex. setup d'appel) et à ne jamais utiliser pour les messages.

---

## ⚪ Faible / hygiène

- **L1 — `.env` versionné dans le dépôt** (présent à la racine du repo). Tout secret qu'il contient est exposé dans l'historique git → à retirer du suivi et **faire tourner les clés**.
- **L2 — Deux sérialisations du header** : la signature utilise `JSON.stringify(header)` (`ratchet.ts:315,531`) alors que l'AAD utilise une forme canonique `dh|pn|n` (`:257`). Incohérent ; repose sur la stabilité de l'ordre des clés JSON entre runtimes.
- **L3 — `unpadPlaintext` non constant-temps** malgré le commentaire (`lengthPadding.ts:38-46`, sortie anticipée sur les zéros).
- **L4 — Vérif. de signature imposée par l'appelant, pas par la primitive** : `ratchetDecrypt` renvoie `verified=false` silencieusement ; c'est `useE2EE.ts:1184-1192` (`rejectUnverified`) qui bloque. Correct aujourd'hui, mais fragile si un nouvel appelant oublie le contrôle.
- **L5 — Rotation Sender Key par âge inopérante** : `maybeAutoRotate` suit l'âge dans un `Map` en mémoire (`senderKeySession.ts:254-275`), remis à zéro à chaque session → la rotation « age » ne se déclenche quasiment jamais (seule la rotation « count » à 1000 fonctionne).

---

## Points conformes (à conserver)

- **X3DH pairwise** conforme : ordre DH1=DH(IKa,SPKb), DH2=DH(EKa,IKb), DH3=DH(EKa,SPKb), DH4=DH(EKa,OPKb), filler 32×`0xFF`, HKDF salt zéro + info — `x3dh.ts:529-605`.
- **Double Ratchet** correct : étape DH + chaîne symétrique, `MK=HMAC(CK,0x01)`, `CK=HMAC(CK,0x02)` (`kdfChain.ts:24-44`), `KDF_RK=HKDF(rootKey, dh)` (`:83-118`), gestion `pn`/`n`, skipped keys bornées + TTL (`ratchet.ts:434-472`).
- **SPK signées et vérifiées**, rotation 7 j, OPK à usage unique supprimée après usage, garde anti-rejeu X3DH (`x3dh.ts`).
- **AES-256-GCM** (plus robuste que l'AES-CBC+HMAC du whitepaper), IV 96 bits, tag 128 bits, **padding de longueur** présent (`lengthPadding.ts`).
- **PBKDF2-600k**, PIN-wrap **local** (IndexedDB) pour les clés au repos (`pinWrap.ts`).

---

## Priorisation suggérée (sans implémentation ici)

1. **C1** — sortir `chain_key_b64`/`signing_priv_jwk` du serveur (refonte du stockage Sender Key en local). Bloquant pour le E2EE des groupes.
2. **H1 + H2** — lier la signature par message et le SKDM à l'identité de confiance de l'expéditeur.
3. **H3 + H4** — corriger le bypass de certificat et revoir la promesse « sealed sender ».
4. **M3 / M5 / M6** — épinglage de la clé primaire ; durcir la sauvegarde par mot de passe ; cantonner le chemin statique.
5. Reste (M1, M2, M4, L1–L5).

---

### Sources
- *WhatsApp Encryption Overview – Technical White Paper*, Meta, v3 (22 oct. 2020).
- Spécifications Signal : [X3DH](https://signal.org/docs/specifications/x3dh/), [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/), [Sender Keys](https://signal.org/docs/specifications/sender-key/).
