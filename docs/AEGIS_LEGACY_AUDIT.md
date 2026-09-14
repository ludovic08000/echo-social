# Audit des anciens systèmes de messagerie — 14 septembre 2026

## Retrait autorisé des modules restants — 15 septembre

Après autorisation explicite, suppression de deviceRatchet.ts,
x3dhRatchetBootstrap.ts, repeatablePreKeyEnvelope.ts et de leurs sept tests
dédiés. Le réexport inutilisé et les mocks obsolètes ont été retirés ; un
contrôle libsignalOnly interdit leur réintroduction. Les tests du vrai WASM
couvrent les ratchets, le renouvellement, les messages retardés et les rejets.
Les fichiers supprimés restent récupérables dans l'historique Git.

Sauvegardes cloud : capture, upload et relecture sont sérialisés par appareil.
La finalisation iOS demande une capture fraîche après provisionnement, sans
réutiliser une sauvegarde antérieure en vol. Les backups prématurés de
prepareKeys sont retirés. Trois tests vérifient ordre, relecture et reprise.

Validation locale du lot : 151 fichiers, 763 tests réussis et 3 ignorés,
TypeScript app/node, build, lint ciblé et vrai WASM réussis. Cette validation
ne prouve pas la récupération après perte complète du coffre, ni le succès
du rejeu SQL et des parcours sur appareils réels. Aucune fusion autorisée.

## Complément du 15 septembre : renouvellement des sessions Libsignal

Les événements de sécurité, la rotation d'identité, la révocation depuis
deviceApi et realtimeKeySync ciblent désormais libsignalSessionFreshness.
Un marqueur scellé par compte ou paire d'appareils impose un nouveau handshake
avant le prochain chiffrement. Il est acquitté seulement après établissement
durable de la session. Les échecs de stockage bloquent le chiffrement ; une
invalidation non persistée reste en attente dans l'instance courante.
Le verrou inter-onglets par compte sérialise invalidation et envoi, puis le
verrou du bridge protège le store partagé. Ce verrou plus large est un choix
conservateur qui peut réduire le parallélisme des envois.

Le test du vrai WASM valide six directions : renouvellement avec le même
correspondant, réception retardée sur l'ancienne session, rejet d'un doublon
après renouvellement et rejet d'une identité substituée. Aucun effacement des
identités connues, préclés ou marqueurs anti-rejeu n'est effectué. Les copies
déjà chiffrées et persistées restent des retries immuables ; l'invalidation
s'applique aux nouveaux chiffrements et ne contourne pas le contrôle serveur
des appareils révoqués.

Limites : le renouvellement ne constitue pas une approbation automatique d'une
nouvelle identité. Le chemin historique repeatablePreKeyEnvelope/deviceRatchet
reste à auditer, ainsi que la récupération après perte complète du coffre et
de ses marqueurs. Validation SQL et tests sur appareils toujours nécessaires.

Base : PR #92, branche `fix/libsignal-runtime-messaging`, commit `db7502a0`.

## Périmètre et limites

Inspection des imports TypeScript depuis `src/main.tsx` (imports statiques,
réexports et imports dynamiques littéraux), recherche des références dans les
sources, scripts, workflows, Android et iOS, lecture du chemin d'envoi, des
coffres, des invalidations et des fonctions serveur concernées.
Ce n'est pas une certification cryptographique ni une vérification de l'état
des fonctions effectivement déployées ou de la base de production.

Le contrôle automatique a initialement refusé le lot groupé. L'utilisateur a
ensuite confirmé explicitement les 23 retraits et l'adaptation des consommateurs.
Ce lot est maintenant appliqué localement (détails ci-dessous).
Les modifications préexistantes de `supabase/functions/mcp/index.ts` et
`supabase/.temp/` sont préservées. Aucune fusion, aucun déploiement.

## Architecture effectivement utilisée

ChatWidget → hook sécurisé / moteur d'envoi Aegis → multiDeviceFanout →
libsignalRuntime → libsignalPlatformBridge → WASM ou plugin natif LibSignal.

Le chiffrement des copies actuelles utilise `aegis.libsignal.*`.
Le fichier autonome `ChatView.tsx` est absent des fichiers inventoriés ;
`WidgetChatView` est un composant interne de ChatWidget, pas un second chat.

## Constats prioritaires

### P1 — invalidations branchées sur l'ancien ratchet

`src/lib/crypto/sessionInvalidation.ts` est lancé par `src/main.tsx`.
Il appelle `clearAllDeviceSessions` dans `deviceRatchet.ts`, qui efface le
store historique `sessions`, pas `aegis.libsignal.store:*`.
`deviceApi.ts`, `realtimeKeySync.ts` et `identityRotation.ts` utilisent aussi
ces anciennes fonctions. Le nettoyage observé ne démontre donc pas
l'invalidation des sessions réellement utilisées par Libsignal.

Action nécessaire : définir l'invalidation Libsignal par appareil/pair sous
verrou, la brancher aux événements de sécurité et tester les changements de
clé/révocations avant de supprimer deviceRatchet. Ne pas simplement effacer
un store entier contenant identités et prekeys au lieu d'une session.

### P1 — rollback de fan-out sur le mauvais stockage

`multiDeviceFanout.ts` appelle `captureFanoutSessionBeforeMutation` avant
`encryptForLibsignalDevice`. `fanoutSessionTransaction.ts` capture/restaure
uniquement `sessions` et `initiating-sessions`. L'envoi réel modifie le store
Libsignal scellé. Les chemins de refus dans `aegisSendRpc.ts` et
`aegisOutboundEngine.ts` appellent encore ce rollback historique.

Action nécessaire : décider une stratégie Libsignal de reprise/durabilité et
tester rejet serveur, livraison incertaine et envois concurrents. Restaurer
aveuglément un ancien store complet pourrait réutiliser un état cryptographique
ou écraser une réception concurrente ; ce n'est pas un remplacement sûr.

### P2 — ancien envoi Zeus en clair toujours présent

`useMessages.ts` réexporte `useMessages.legacy.ts`, puis masque son
`useSendMessage` par celui de `useSendMessageSecure.ts`.
Le module historique garde un envoi Zeus via insertion dans `messages`,
ainsi qu'un second hook d'envoi et ses mises à jour optimistes.
Le chemin public est sécurisé, mais le code interdit reste réutilisable.

`supabase/functions/agent-chat/index.ts` garde `pushToMessenger`, encore
appelé après certaines réponses Zeus. Les migrations de protection bloquent
ce chemin dans une base alignée, mais le producteur serveur reste actif.

Action : conserver lecture/conversations dans useMessages.ts, conserver le
seul export sécurisé, supprimer le second hook et sendToZeus ; supprimer le
push serveur sans supprimer l'espace IA ni ses tables/messages propres.
Conserver les gardes SQL anti-plaintext.

### P2 — ancien bridge natif incompatible avec le moteur courant

`lib/libsignalNative.ts` déclare les méthodes historiques ensureDevice,
encryptForDevice et decryptFromDevice et annonce `available: false` sur Web.
Il reste chargé par les diagnostics DEV de main.tsx.
`messaging/aegisCryptoEngine.ts` et `libsignalBundleRegistry.ts` utilisent ce
bridge et l'ancien format `aegis2.libsignal.*`, mais ne sont pas accessibles
depuis l'entrée applicative inspectée.

Action : utiliser getLibsignalBackendInfo du bridge courant pour le diagnostic,
retirer le bridge historique et ses consommateurs morts. Ne pas supprimer le
plugin natif actuel ni libsignalPlatformBridge/aegisWasmBridge.

### P2 — double sauvegarde historique et Libsignal

`webDeviceKeyVault.ts` sauvegarde et restaure les snapshots X3DH, les anciennes
sessions maison ET libsignalStore. Il importe directement aegisWasmBridge
pour le store ; le bridge multiplateforme expose aussi capture/restore.
Les anciens snapshots ne sont donc pas tous du code mort.

Action : vérifier les parcours de restauration Web/natifs et les obligations
actuelles de routage avant de retirer les anciens champs. La publication
device_signed_prekeys est toujours requise par le parcours prepareKeys actuel.

### P3 — pile Matrix déconnectée de l'interface

Les 7 modules src/lib/matrix ne sont accessibles depuis main.tsx par aucun
import littéral inspecté. MatrixAttachmentBubble n'a pas de consommateur.
Restent les dépendances npm Matrix, la configuration de chunks/cache Vite,
deux fonctions serveur, une infrastructure Compose et un guide de migration.
Leur présence ne prouve pas qu'un service Matrix est déployé.

Action : retirer client, composant, dépendances/lockfile et configuration
associée ; retirer les sources serveur et l'infra seulement avec portée
explicite. La suppression des sources ne dépublie pas une Edge Function.

### P3 — autres surfaces historiques

- `messaging/provider.ts`, `types.ts`, `index.ts` : registre de fournisseurs
  externes sans point d'entrée applicatif dans le graphe inspecté.
- `repeatablePreKeyEnvelope.ts` et `x3dhRatchetBootstrap.ts` : ancien bootstrap
  maison, référencé par des tests mais pas par le runtime applicatif inspecté.
- Le graphe signale également cryptoApi.ts (sous lib/crypto),
  deviceApprovalFingerprint, devicePairing, devicePrekeyRepair,
  invalidDeviceCache, keyConsistencyGuard, ktMerkle, lengthPadding,
  postRestoreLifecycle, recoveryManager et sessionResetTracker comme non
  accessibles depuis main. Cela ne suffit pas à justifier leur suppression :
  certains ont des composants dormants ou des tests consommateurs.
- `.github/workflows/e2ee-remove-signed-list-bridge.yml` contient un correctif
  ponctuel auto-commit pour une ancienne branche ; ce n'est pas le workflow
  de la PR actuelle.

## Lot de suppression confirmé et appliqué

Avec les modifications des consommateurs/tests décrites ci-dessus :

- src/hooks/useMessages.legacy.ts
- src/lib/libsignalNative.ts
- src/lib/__tests__/libsignalNative.test.ts (remplacer par tests du diagnostic actuel)
- src/lib/messaging/aegisCryptoEngine.ts
- src/lib/messaging/libsignalBundleRegistry.ts
- src/lib/messaging/provider.ts
- src/lib/messaging/types.ts
- src/lib/messaging/index.ts
- src/components/messages/MatrixAttachmentBubble.tsx
- src/lib/matrix/client.ts
- src/lib/matrix/config.ts
- src/lib/matrix/config.test.ts (remplacer par garde d'absence Matrix)
- src/lib/matrix/index.ts
- src/lib/matrix/media.ts
- src/lib/matrix/messages.ts
- src/lib/matrix/rooms.ts
- src/lib/matrix/session.ts
- infra/matrix/.env.example
- infra/matrix/README.md
- infra/matrix/compose.yaml
- docs/MATRIX_MIGRATION.md
- supabase/functions/matrix-route/index.ts
- supabase/functions/matrix-session/index.ts

Modifiés avec ce lot : useMessages.ts, main.tsx, agent-chat/index.ts,
vite.config.ts, package.json et lockfile, tests Zeus/contrats d'architecture.
Ne pas supprimer des tests de sécurité sans garder les invariants dans les
tests du chemin actuel.

## Éléments à préserver

- Historique SQL : retirer des migrations anciennes casserait le replay et
  pourrait supprimer les gardes de sécurité. Une éventuelle suppression de
  tables/RPC doit passer par une nouvelle migration contrôlée.
- third_party/libsignal : les fichiers upstream contenant legacy ne sont pas
  automatiquement des anciens systèmes applicatifs.
- Artefacts natifs/WASM et tests d'interopérabilité du moteur courant.
- Coffres et restauration encore utilisés jusqu'à leur migration testée.

## Vérification avant modifications

Vitest complet, un seul worker : 750 tests réussis, 3 ignorés, 0 échec.
Rapport JSON : `C:/fan forge/aegis-audit-baseline.json`.
Ces tests passent sur la base inchangée ; cela ne valide ni les suppressions
proposées ni les scénarios de sécurité manquants mentionnés ci-dessus.
Les tests natifs sur appareil et le déploiement distant n'ont pas été exécutés
dans cet audit. Après nettoyage : tests complets, WASM réel, typecheck, build,
puis scénarios de refus/réessai, changement de clé et restauration.

## Exécution du nettoyage confirmé

- Les 23 anciens chemins listés sont supprimés. La partie lecture/conversations
  de useMessages.legacy.ts est conservée directement dans useMessages.ts ; son
  second hook d'envoi et sendToZeus sont retirés. L'unique export d'envoi public
  reste useSendMessageSecure.
- Le serveur agent-chat conserve l'espace IA et ai_agent_messages, mais ne
  pousse plus de texte en clair dans messages/conversations.
- Les diagnostics DEV utilisent getLibsignalBackendInfo du bridge courant,
  sans ancien self-test natif incompatible avec ce bridge.
- Dépendances Matrix retirées de package.json ; package-lock.json régénéré
  avec npm, bun.lock régénéré avec Bun, sans scripts d'installation.
- Deux fichiers de tests obsolètes sont remplacés par des tests du choix du
  backend Web/Android/iOS, du refus d'ABI native incompatible, de l'absence des
  anciens chemins et du maintien de la frontière entre IA et messagerie E2EE.
- Migrations historiques, types SQL générés, coffres et restauration restent
  inchangés. Les sources retirées ne constituent pas une suppression distante
  des fonctions Matrix déjà éventuellement déployées.
- Les constats P1 (rollback et invalidation) et la double sauvegarde restent
  ouverts. Ce lot ne prétend pas les corriger.

### Validation après nettoyage

- Vitest complet : 753 tests réussis, 3 ignorés, aucun échec
  (`C:/fan forge/aegis-audit-after.json`).
- Tests supplémentaires d'absence Matrix dans bun.lock : 5/5 réussis.
- TypeScript app et node : succès.
- Vérification réelle WASM : six directions entre trois identités, avec trois
  aller-retours et sérialisation des stores pour chacune, succès.
- Vite production et génération PWA : succès ; avertissements préexistants
  Tailwind/PostCSS et taille/découpage des chunks toujours présents.
- Pas de validation native sur appareil ni d'exécution distante d'agent-chat.

## Remplacement du rollback confirmé le 15 septembre 2026

- Retrait de fanoutSessionTransaction.ts et de son test lié aux anciens stores.
  Les refus serveur ne restaurent plus de snapshots de sessions.
- Le fanout conserve chaque copie scellée avant de la transmettre. Un retry
  réutilise cette copie pour le même message/appareil/clé publique. Un contenu
  différent sous le même identifiant est refusé. Une nouvelle clé destinataire
  ne réutilise pas la copie de l'ancienne clé.
- Tests d'intégration : fanout partiel puis reprise, route périmée suivie d'une
  réponse ambiguë, confirmation avec les mêmes copies, absence de restauration
  de session dans le transport. Les tests du vrai WASM couvrent aussi trous,
  réception désordonnée, doublons, altération et reprise après rejet.
- Verrou du store Libsignal partagé entre onglets et entre conversations.
- Le correctif de provisionnement refuse un coffre privé absent lorsque des
  bundles publics existent ; cela ne remplace pas un parcours de récupération.
- Restent à terminer : invalidation des sessions courantes, récupération complète,
  validation SQL sur une base isolée et validation fonctionnelle sur appareils.
  Ces changements locaux ne constituent ni une fusion ni un déploiement.
# Restauration Libsignal — contrôle complémentaire

Le 15 septembre 2026, les bridges web et natif refusent désormais de remplacer
un store présent par un snapshot différent (`AEGIS_LIBSIGNAL_RESTORE_CONFLICT`).
Une restauration identique est sans écriture ; un store absent est restauré
sous le verrou de l'appareil, avec relecture du coffre avant succès.
La restauration du coffre vérifie ce conflit avant d'écrire les autres clés,
et passe par le bridge de plateforme pour la capture et la restauration.

Dix tests couvrent les deux chemins : absence, identité du snapshot, conflit,
échec de lecture et échec de relecture. Cette protection ne démontre pas la
fraîcheur d'une sauvegarde lorsque le store local a entièrement disparu : la
récupération complète et l'invalidation des sessions restent à terminer.
La validation SQL locale reste indisponible : le moteur Docker ne répond pas.
