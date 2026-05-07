## D3 — Appels de groupe (jusqu'à 8 participants)

### 1. Base de données (migration)

Étendre `active_calls` pour le multi-appelés :
- Ajouter `caller_ids uuid[]` (liste des invités) — `callee_id` reste pour rétro-compat 1-to-1.
- Ajouter `is_group boolean default false`.
- Ajouter `accepted_by uuid[]` (qui a accepté), `declined_by uuid[]` (qui a refusé).
- Le `room_id` (déjà en place) sert de room LiveKit partagée.

Nouvelle vue / fonction RPC `get_active_group_call(room_id)` pour lister les participants en temps réel.

Trigger : quand tous les invités ont décliné OU quand le créateur raccroche → status = `ended`.

### 2. Démarrage d'un appel de groupe

- Depuis `ChatWidget` (conversation 1-to-1) : bouton "ajouter participant" ouvre un picker d'amis.
- Depuis une conversation groupée (si la table `conversations` a `is_group`) : bouton 📞/📹 lance directement un appel groupe avec tous les membres.
- Insert unique dans `active_calls` avec `caller_ids = [...uids]`, `is_group = true`, `room_id = uuid()`, `status = 'ringing'`.
- Le trigger push (déjà en place) sonne en parallèle chez tous les invités via leurs `push_subscriptions`.

### 3. Réception (sonnerie parallèle)

- `useIncomingCall` écoute déjà `active_calls` ; on étend pour matcher `auth.uid() = ANY(caller_ids)`.
- `IncomingCallOverlay` affiche : "Untel + 3 autres vous appellent".
- Quand un invité accepte → update `accepted_by = array_append(accepted_by, uid)`, status reste `ringing` jusqu'à ce que le 1er accepte → passe à `accepted`.
- Décliner → `declined_by` ; si tous ont décliné → status `declined`, l'appelant voit "Personne n'a répondu".

### 4. Grille N participants

Nouveau composant `<GroupCallGrid />` :
- Layout adaptatif : 1=plein écran, 2=côte à côte, 3-4=2x2, 5-6=2x3, 7-8=3x3 (placeholder vide pour case impaire).
- Chaque tile = `<RemoteParticipantTile>` avec vidéo LiveKit, nom, indicateur micro coupé, qualité réseau.
- L'utilisateur local en PiP (coin bas-droite) ou dans la grille si > 4.
- Mise à jour live : `room.on(ParticipantConnected/Disconnected)` re-render.
- `CallOverlay` détecte `is_group` et bascule vers `GroupCallGrid` au lieu du layout 1-to-1.

### 5. Contrôles d'appel groupe

- Mute / cam off / partage écran : déjà en place via `useCall`.
- Nouveau : bouton "ajouter participant" en cours d'appel → insère dans `caller_ids` → push sonne le nouveau.
- Bouton "quitter" : un participant peut sortir sans terminer l'appel pour les autres.
- Si le créateur quitte ET reste ≥ 2 participants : transfert automatique de propriété.
- Si reste ≤ 1 : appel auto-terminé.

### 6. Historique

`call_history` (déjà en place via trigger) : on stocke `participants uuid[]` au lieu de `callee_id` seul pour les groupes, et `duration` = max des durées.

### 7. E2EE LiveKit

LiveKit gère nativement le SFrame E2EE pour la room ; même clé dérivée du `room_id` partagée par tous les participants au moment du `connect()` (déjà actif pour le 1-to-1 via `e2ee.keyProvider`).

---

### Plan technique condensé

```text
Migration SQL
 ├─ ALTER active_calls (caller_ids, is_group, accepted_by, declined_by)
 ├─ ALTER call_history (participants uuid[])
 └─ Trigger update_call_history_group

src/hooks/useCall.ts
 └─ Support is_group dans connectToRoom / endCall

src/hooks/useIncomingCall.ts
 └─ Filter: callee_id = uid OR uid = ANY(caller_ids)

src/components/calls/GroupCallGrid.tsx        ← nouveau
src/components/calls/RemoteParticipantTile.tsx ← nouveau
src/components/calls/AddParticipantSheet.tsx   ← nouveau

src/components/CallOverlay.tsx
 └─ if (isGroup) render <GroupCallGrid /> else current layout

src/components/ChatWidget.tsx
 └─ Bouton "appel groupe" pour conversations groupées
```

### Hors scope (à part)

- Réactions emoji en appel
- Flou d'arrière-plan / fond virtuel
- Enregistrement d'appel
- Visioconférence > 8 (nécessiterait config SFU + simulcast renforcé)

### Estimation

~6-8 fichiers modifiés/créés + 1 migration. L'effort principal est la grille adaptative et le multi-callee signaling.

---

**Tu valides ce plan ? Je code direct ?**
