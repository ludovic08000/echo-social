# Revue de sécurité Signal / ForSure Aegis — 27 septembre 2026

## Portée et méthode

Cette revue compare le code présent dans cette branche aux mécanismes publiquement documentés par Signal. Elle ne constitue ni une certification Signal, ni un audit cryptographique indépendant. L'objectif du lot est volontairement limité : corriger le démarrage des appels chiffrés, rendre les échecs diagnostiquables et conserver une régression immédiate qui ne touche jamais l'envoi des messages.

Références officielles consultées :

- [PQXDH](https://signal.org/docs/specifications/pqxdh/) — établissement de session asynchrone et post-quantique ;
- [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) — renouvellement des clés par message et récupération après compromission ;
- [Sesame](https://signal.org/docs/specifications/sesame/) — gestion des sessions multi-appareils ;
- [Automatic Key Verification](https://signal.org/blog/automatic-key-verification/) — transparence des clés et détection d'une substitution serveur ;
- [Large E2EE calls](https://signal.org/blog/how-to-build-encrypted-group-calls/) et [Group Calls](https://signal.org/blog/group-calls/) — chiffrement des appels et renouvellement des clés de participant ;
- [ICE forking](https://signal.org/blog/ice-forking/) — appels multi-appareils ;
- [Signal Secure Backups](https://support.signal.org/hc/en-us/articles/10075139325850-Troubleshooting-Signal-Secure-Backups) — restauration chiffrée contrôlée par l'utilisateur.

## Comparaison

| Contrôle | Signal documenté | ForSure Aegis observé | État |
|---|---|---|---|
| Établissement de session | PQXDH | Runtime Libsignal, bundles de préclés par appareil | Présent, tests WASM à conserver |
| Renouvellement des clés de message | Double Ratchet | Sessions Libsignal par appareil | Présent |
| Multi-appareils | Sesame | Registre canonique, routage et fan-out par appareil, révocation | Présent, logique spécifique Aegis |
| Vérification d'identité | Numéro de sécurité + transparence des clés | Alerte de changement d'identité, empreinte Aegis et journal Merkle | Partiel : pas de preuve d'équivalence avec NumericFingerprint ; pas d'auditeurs indépendants |
| Expéditeur confidentiel | Sealed Sender | Jeton scellé et relais à contenu aveugle | Présent, implémentation Aegis |
| Sauvegarde après effacement | Sauvegarde chiffrée avec secret utilisateur | Coffre et archive chiffrés, restauration navigateur en cours dans cette PR | Présent dans la branche, validation de production encore nécessaire |
| Appels individuels | Média E2EE, participants autorisés | LiveKit E2EE avec clé de média 256 bits enveloppée X25519/HKDF/AES-GCM pour chaque appareil autorisé | Présent et durci dans ce lot |
| Appels de groupe | Clés propres aux participants et rotation lors des changements de groupe | Une clé de média commune distribuée aux appareils invités | Écart important : rotation join/leave et clés par émetteur à planifier |
| Résistance post-quantique continue | Triple Ratchet/SPQR selon les spécifications récentes | PQXDH/Double Ratchet Libsignal observés ; SPQR non démontré | Non démontré |
| Transparence des clés | Journal vérifiable et surveillance externe | Merkle local et publication d'époques | Partiel : signature/inclusion non vérifiées de bout en bout dans l'UI ; arbre pas clairement cumulatif ; clé de signature éphémère possible si la configuration manque |

## Diagnostic de l'impossibilité d'appeler

La cause racine cryptographique a été confirmée par un test réel X25519/HKDF/AES-GCM : les données authentifiées associées (AAD) n'étaient pas construites avec les mêmes champs à l'émission et à la réception. La clé de média était donc correctement enveloppée mais son ouverture échouait systématiquement avant la connexion LiveKit. L'AAD est désormais limité aux quatre identifiants immuables de l'invitation (`callId`, `conversationId`, `recipientUserId`, `recipientDeviceId`) et un test aller-retour empêche la régression.

Les preuves publiques confirmaient que la fonction `livekit-token` était déployée et refusait correctement une requête non authentifiée. Sans session utilisateur de test ni rapport d'appel, il n'était pas possible d'attribuer chaque échec de production à une cause unique. L'inspection a néanmoins identifié quatre défauts concrets :

1. Le client appelait `refreshSession()` avant chaque jeton LiveKit. Un verrou navigateur Supabase déjà détenu par un autre onglet pouvait donc empêcher l'appel alors que le JWT courant était encore valide.
2. Un refus du micro ou de la caméra quittait le démarrage sans toujours clore la signalisation ; l'appel pouvait rester en état `ringing` ou `accepted`.
3. La fonction LiveKit renvoyait des erreurs génériques sans identifiant de diagnostic et utilisait ses secrets/configurations sans validation préalable.
4. Plusieurs surfaces affichaient directement `error.message`, ce qui pouvait exposer des identifiants internes et ne permettait pas à l'utilisateur de corriger le vrai blocage.

## Changements réalisés dans ce lot

- validation canonique et stricte de la clé de média de 32 octets ;
- correction et verrouillage par test de l'AAD des enveloppes d'appel ;
- validation stricte de l'enveloppe d'invitation, de son appel, de sa conversation, de son type et de sa salle ;
- maintien obligatoire de LiveKit E2EE : aucun repli non chiffré ;
- fermeture de la signalisation quand le démarrage, les permissions ou la connexion échouent ;
- renouvellement de session seulement lorsque le JWT approche réellement de son expiration ; un verrou transitoire ne bloque plus un JWT encore valide ;
- jetons LiveKit limités à dix minutes, configuration validée avant signature, salle limitée à `call-<uuid>` ou `live-<uuid>` ;
- contrôle serveur de l'appareil actif/approuvé/non révoqué et de l'invitation exacte avant émission d'un jeton d'appel ;
- codes d'erreur stables, messages utilisateur sans identifiant brut et `x-aegis-diagnostic-id` ;
- cache des jetons LiveKit cloisonné par compte, salle et appareil afin d'empêcher sa réutilisation après un changement d'utilisateur ;
- tampon borné de diagnostics d'appel, sans clé, jeton, UUID brut, contenu audio, vidéo ou message ;
- ajout de la section `calls` dans `forsureDebug.report()` ;
- tests d'isolation garantissant que le coupe-circuit des appels n'est importé par aucun chemin d'envoi de message.

## Régression et retour arrière

Le lot ne contient aucune migration de base de données et ne modifie ni le format des messages, ni le moteur Aegis sortant, ni la file d'envoi.

1. Retour opérationnel immédiat : définir `VITE_AEGIS_CALLS_ENABLED=false` puis redéployer. Les appels sont désactivés proprement, les messages continuent de fonctionner et aucun appel non chiffré n'est autorisé.
2. Retour code : révoquer le commit isolé de ce lot. Aucun retour de schéma n'est requis.
3. Observation : exécuter `await forsureDebug.report()` et examiner `calls`. Les références `call-*`, `conv-*` et `dev-*` sont locales et opaques.
4. Réactivation : retirer la variable ou la remettre à `true`, redéployer, puis tester audio et vidéo entre deux comptes possédant chacun un appareil `ready`.

## Critères avant mise en production

- typecheck, tests d'appel, tests de confidentialité, suite complète, vérification Libsignal WASM et build de production au vert ;
- test réel audio puis vidéo entre deux comptes et deux navigateurs ;
- test refus micro/caméra : l'appel distant doit cesser de sonner ;
- test appareil révoqué : aucun jeton LiveKit ne doit être émis ;
- test expiration/onglets multiples : un verrou de rafraîchissement ne doit pas bloquer un JWT encore valide ;
- export du diagnostic sans clé, jeton, UUID brut ni contenu de message ;
- surveillance du taux de `CALL_*` et capacité à activer le coupe-circuit sans redéployer le serveur de messages.

## Travaux de sécurité restant à traiter séparément

1. Concevoir une rotation de clé d'appel lors de chaque entrée/sortie et des clés média par émetteur pour les groupes. Ce changement de protocole nécessite compatibilité de version et tests à plusieurs participants.
2. Rendre la transparence des clés réellement vérifiable : arbre cumulatif, clé de signature obligatoire et stable, preuve d'inclusion vérifiée côté client et moniteur indépendant.
3. Démontrer ou ajouter la stratégie Triple Ratchet/SPQR sans remplacer silencieusement les sessions existantes.
4. Faire examiner les primitives et protocoles Aegis par un audit cryptographique externe. Utiliser Libsignal réduit le risque d'implémentation, mais ne certifie pas automatiquement tout le routage, la sauvegarde et les appels autour de la bibliothèque.
