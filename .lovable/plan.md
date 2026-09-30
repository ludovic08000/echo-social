# Diagnostic (lecture seule) — validation e-mail bloquée / route E2EE indisponible

Rien n'a été modifié. Aucun e-mail, UUID, DeviceID ni clé n'apparaît ci-dessous.

## Constats agrégés (production, 30/09/2026 ~14:40 UTC)

**login_security_sessions (18 lignes, toutes créées le 30/09 entre 05:53 et 14:22)**
- 12 approuvées via `trusted_device` : toutes avec `device_id` renseigné, appareil actif et `routing_status=ready`.
- **3 approuvées via `email` : toutes avec `device_id = NULL`** (12:11 → 14:21), session auth encore vivante.
- 3 `pending` sans `device_id`.
- 13/18 ne correspondent plus à aucune ligne `auth.sessions` (sessions expirées / remplacées, non nettoyées).

Conclusion : l'approbation par e-mail valide la **session de connexion**, jamais un **appareil**. Le chemin `email_decision` (`supabase/functions/login-security/index.ts`, l. ~431-470) ne touche que `target_session_id` ; seule l'approbation `trusted_device` (l. ~541-690) porte une preuve d'appareil. Une session peut donc être « approuvée » alors que le navigateur n'a aucun appareil enrôlé ou routable. C'est le motif global, pas un cas isolé.

**user_devices (31 lignes, 24 actives, 0 révoquée, 0 `crypto_invalid`)**
- 10 : approved + bound + bundle Libsignal + `ready` (sain).
- **10 : approved + bound, actifs, SANS bundle Libsignal, `routing_status=repairing`**, tous figés depuis le 17/09 (dont 3 marqués `lifecycle_status=ready` malgré l'absence de bundle — incohérence d'état).
- 7 : `pending`, inactifs, `repairing` (17/09 → 23/09) — enrôlements abandonnés jamais nettoyés.
- 4 : `ready` avec bundle mais `lifecycle_status` resté `approved` / `syncing` (dérive d'étiquette, sans impact de routage).

Date du 17/09 = juste après la migration `20260915180000_require_libsignal_bundle_for_route.sql` et la purge crypto legacy : ces appareils ont perdu leurs prékeys personnalisées et n'ont jamais re-provisionné de bundle Libsignal.

**Comptes (21 avec identité serveur dans `user_public_keys`)**
- **16 : identité serveur, aucun appareil du tout, aucune sauvegarde** → toujours `E2EE_PARTICIPANT_ROUTE_UNAVAILABLE` côté expéditeur (`deviceRegistry.listFanoutTargets`).
- 1 : approuvé par e-mail, aucun appareil, aucune sauvegarde → profil exact de l'incident observé.
- 1 : approuvé par e-mail, appareil `ready`, sauvegarde présente → sain.
- 2 : mélange ready + repairing + inactif, sauvegarde présente.
- 1 : sain.
- 17/21 n'ont aucun appareil `ready`.

**Réparation ponctuelle antérieure** : aucune migration ni trace nommée pour cet incident dans `supabase/migrations` ; aucune donnée réparée détectable (aucune ligne révoquée ou marquée). À confirmer via `audit_logs` si besoin.

## Flux client (rechargement / nouvel onglet)
- `LoginSecurityEmailDecisionBridge.tsx` soumet un formulaire natif vers la fonction : **navigation pleine page** → mot de passe et PIN en mémoire perdus par conception (clés en RAM uniquement).
- Si le clic se fait dans un autre onglet/appareil, l'onglet d'origine doit relire le statut ; sinon il reste sur « Confirme ton identité ».
- Après retour, la machine d'état doit reprendre à `DEVICE_CREDENTIAL_CHECK` ; sans credential locale → `LINK_REQUIRED`, pas le PIN. Le blocage observé correspond à : session approuvée + aucun appareil + aucune sauvegarde → aucune clé restaurable.

## Algorithme de réparation global (respecte les invariants)
1. **Séparer les deux notions** : l'e-mail approuve la session ; l'appareil suit sa propre cérémonie (`begin_user_device_enrollment` → approbation → `bind_device_account` → `prepareKeys` → `mark_current_device_route_ready`).
2. Après approbation e-mail, l'onglet d'origine relit le statut (Realtime ou polling court), puis relance le lifecycle depuis `DEVICE_CREDENTIAL_CHECK`. Jamais de PIN avant `APPROVED_LOCKED`.
3. Appareils `approved+bound` sans bundle : ne **jamais** forcer `ready`. Les basculer en « re-provisionnement requis » ; au prochain déverrouillage PIN du même DeviceID, publier le bundle Libsignal (SPK signée + OPK + Kyber) ; `mark_current_device_route_ready` ne passe que si le bundle existe (garde déjà en place, `LIBSIGNAL_BUNDLE_REQUIRED`).
4. Corriger l'étiquette `lifecycle_status=ready` sans bundle → `approved` (correction d'état, pas de confiance ajoutée).
5. Comptes avec identité mais sans appareil ni sauvegarde : la clé privée n'existe plus nulle part → seule issue honnête : `identity-reset` (mot de passe + session approuvée) puis nouvel enrôlement ; afficher « messages précédents illisibles ».
6. Nettoyage : expirer les `pending` inactifs > 7 j et les `login_security_sessions` sans `auth.sessions`.
7. Tests de non-régression : approbation e-mail n'implique jamais appareil approuvé ; pas de `ready` sans bundle ; reprise après rechargement → `LINK_REQUIRED` et non PIN.

## Détails techniques
- Tables : `login_security_sessions`, `login_security_email_tokens`, `auth.sessions`, `user_devices`, `device_libsignal_prekey_bundles`, `user_public_keys`, `user_backups`.
- Fonctions : `login-security` (`email_decision`, upsert `approved_via`), `mark_current_device_route_ready(text)`, `list_active_devices_for_user`, `aegis_resolve_conversation_route`.
- Client : `LoginSecurityEmailDecisionBridge.tsx`, `LoginSecurityBoundary.tsx`, `deviceLifecycleMachine.ts`, `deviceRegistry.ts`.
- Non vérifié : magasin Libsignal local (IndexedDB, côté navigateur), détail OPK/Kyber par appareil, `audit_logs` de l'incident.

Si vous approuvez, l'étape suivante serait d'implémenter les points 2, 3, 4, 6 et 7 (sans déploiement), le point 5 restant une action utilisateur.
