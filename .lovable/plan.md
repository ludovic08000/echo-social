# Durcissement X3DH + Double Ratchet — alignement Signal/WhatsApp

## Objectif
Combler les 7 écarts identifiés vs spec Signal X3DH (rev.1) + Sesame, sans casser les conversations existantes.

## Stratégie de compatibilité
Tous les changements de format passent par **bump de version d'enveloppe** : `PROTOCOL_VERSION` actuel = ancien comportement, `PROTOCOL_VERSION+1` = nouveau. Les ratchets existants continuent à fonctionner ; les nouvelles sessions adoptent le format durci. Pas de migration brutale.

## Lot 1 — Sans risque, déployable immédiatement

### 1.1 Anti-replay des messages X3DH initiaux (spec §4.6)
- Nouvelle store IndexedDB `forsure-x3dh-replay` : clé = `sha256(IKa||EKa||spkId||opkId)`, TTL 7j.
- Vérification dans `x3dhRespond` + `x3dhRespondForDevice` **avant** de consommer l'OPK.
- Si déjà présent → throw `X3DH_REPLAY_DETECTED`.
- GC automatique des entrées > 7j à chaque appel.

### 1.2 Garbage-collect des SPK privés expirés
- Dans `refreshSignedPrekeyIfNeeded`, scan IDB et suppression des SPK > 30j (per-user et per-device).
- Log `[X3DH][GC] purged N expired SPK privates`.

### 1.3 Re-router 100 % du 1-1 vers le chemin per-device (récupère DH4)
- Dans `messageQueue.ts` / `multiDeviceFanout.ts` : supprimer le fallback `fetchPrekeyBundle` (legacy 3-DH only) quand un `device_id` est résolu.
- Garde `fetchPrekeyBundle` uniquement comme dernier secours si la table `device_signed_prekeys` est vide pour ce peer (rétro-compat amis n'ayant pas encore migré).
- Ajoute log `[X3DH][ROUTE] per-device 4-DH` vs `[X3DH][ROUTE] legacy 3-DH fallback`.

## Lot 2 — Breaking, version d'enveloppe v2

### 2.1 AD (Associated Data) lié aux identités — spec §3.3
- Étendre `RatchetState` avec `peerIdentityKey: string` et `myIdentityKey: string` (snapshot au init X3DH).
- Construire `AD = base64(IKa) || '|' || base64(IKb)` (ordre canonique : initiateur en premier).
- Passer `additionalData: encodeString(AD)` à `crypto.subtle.encrypt`/`decrypt` AES-GCM (lignes 215, 386 de `ratchet.ts`).
- Inclure aussi AD dans la donnée signée Ed25519 (sigData lignes 223 + 397).
- Bump `PROTOCOL_VERSION` → 2. Branche le decrypt : `envelope.v === 1` → ancien chemin sans AD ; `v === 2` → AD obligatoire.

### 2.2 Liaison cryptographique du `spkId` (closes #5)
- Nouveau format de signature SPK :
  `signature = Ed25519.sign(IKpriv, "FORSURE-SPK-v2" || uint32_BE(spkId) || rawSpkPub)`.
- Champ `spk_signature_version` ajouté aux tables `user_signed_prekeys` + `device_signed_prekeys` (default `1`).
- `verifySignedPrekey` détecte la version ; v2 vérifie le préfixe + ID, v1 reste accepté en lecture jusqu'au `2026-09-01` (cf. mémoire "Sender Keys Foundation" extinction date).
- Toute nouvelle SPK générée → v2 directement.

### 2.3 Signature individuelle des OPK (closes #7)
- Colonne `signature TEXT` ajoutée à `device_one_time_prekeys`.
- Génération dans `refillDeviceOneTimePrekeysIfNeeded` :
  `sig = Ed25519.sign(IKpriv, "FORSURE-OPK-v1" || uint32_BE(opkId) || rawOpkPub)`.
- `claim_device_one_time_prekey` RPC retourne aussi la signature.
- Vérification côté Alice avant `dh4`. Si absente (legacy OPK pré-migration) → accepté avec warning, dépréciation au `2026-09-01`.

## Lot 3 — Recherche / moyen terme (NON dans cette PR)

- **PQXDH** via `@noble/post-quantum` (ML-KEM-768 hybridé). Nécessite audit dépendance + test perf mobile. Sera proposé séparément.
- **Sesame Device Manifest signé** : audit du flux `e2ee-session/deviceRegistry.ts` requis avant.

## Migrations DB à créer

```sql
-- 2.2
ALTER TABLE public.user_signed_prekeys
  ADD COLUMN signature_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE public.device_signed_prekeys
  ADD COLUMN signature_version SMALLINT NOT NULL DEFAULT 1;

-- 2.3
ALTER TABLE public.device_one_time_prekeys
  ADD COLUMN signature TEXT;
ALTER TABLE public.device_one_time_prekeys
  ADD COLUMN signature_version SMALLINT NOT NULL DEFAULT 0; -- 0 = legacy unsigned
-- Mettre à jour la function claim_device_one_time_prekey pour retourner signature + version.
```

## Fichiers modifiés
- `src/lib/crypto/x3dh.ts` (1.1, 1.2, 2.2, 2.3)
- `src/lib/crypto/ratchet.ts` + `deviceRatchet.ts` (2.1)
- `src/lib/crypto/constants.ts` (`PROTOCOL_VERSION` → 2)
- `src/lib/messaging/messageQueue.ts` + `multiDeviceFanout.ts` (1.3)
- 1 migration SQL
- Tests : `src/lib/crypto/__tests__/x3dh-replay.test.ts`, `ratchet-ad.test.ts`

## Risques
- **Lot 2.1 (AD)** : un bug = impossibilité totale de déchiffrer les nouveaux messages. Tests obligatoires + canary release.
- **Lot 1.3 (routing)** : peut exposer des bugs dormants du chemin per-device pour des paires d'amis qui n'avaient jamais utilisé OPK.
- **Pas de risque** sur Lot 1.1 et 1.2.

## Plan d'exécution recommandé
1. Lot 1 d'abord (3 commits, déployable la même journée).
2. Tester 48h en prod.
3. Lot 2 ensuite, dans 3 PRs séparées (2.1, 2.2, 2.3) avec tests unitaires.
4. Lot 3 plus tard, après stabilisation.

Confirme-moi : **on attaque Lot 1 maintenant**, ou tu veux qu'on fasse aussi le Lot 2 dans la foulée ?
