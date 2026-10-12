# Revue de sécurité Signal / ForSure Aegis — 27 septembre 2026

## Portée et méthode

Cette revue compare le code présent dans cette branche aux mécanismes publiquement documentés par Signal. Elle ne constitue ni une certification Signal, ni un audit cryptographique indépendant. L'objectif du lot est volontairement limité : corriger le démarrage des appels chiffrés, rendre les échecs diagnostiquables et conserver une régression immédiate qui ne touche jamais l'envoi des messages.

La section « Durcissement du 12 octobre 2026 » décrit les modifications ultérieures de la branche. Les sections précédentes restent le relevé historique du lot du 27 septembre, notamment lorsqu'elles mentionnent l'absence de migration.

Références officielles consultées :

- [PQXDH](https://signal.org/docs/specifications/pqxdh/) — établissement de session asynchrone et post-quantique ;
- [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) — renouvellement des clés par message et récupération après compromission ;
- [Sesame](https://signal.org/docs/specifications/sesame/) — gestion des sessions multi-appareils ;
- [Sealed Sender](https://signal.org/blog/sealed-sender/) — confidentialité de l'expéditeur au niveau du transport ;
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
| Expéditeur confidentiel | Sealed Sender | Le relais transporte un marqueur aléatoire de réveil, pas le message chiffré | Non réalisé de bout en bout ; la transaction canonique authentifiée conserve `sender_id` |
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

## Durcissement du 12 octobre 2026

Les changements ci-dessous sont locaux, non fusionnés et non publiés. Ils conservent les clés privées, le format des messages Libsignal et les archives existantes. Ils ne valent pas validation des versions iOS et Windows en production.

### Corrections sans changement du protocole de message

- Retrait du sélecteur GIF dans la messagerie et les commentaires, sans supprimer les GIF historiques.
- Priorité à l'empreinte de contact déjà connue localement. Une réponse serveur divergente ne l'écrase pas silencieusement. Les appels sortants et entrants passent également par ce contrôle et ne génèrent plus une clé d'appareil manquante pour tenter un appel.
- Accusés de lecture limités aux messages entrants déchiffrés visibles dans une page active, hors mode fantôme et contenus à vue unique ; les échecs d'envoi restent réessayables.
- Entretien des préclés en réception, hors du chemin critique de synchronisation, avec fenêtre réussie de cinq minutes et délai de reprise après erreur d'une minute.
- Séparation de la disponibilité d'un appareil et de son stock de préclés. Une session déjà établie reste routable avec un stock vide. Une nouvelle session nécessite toujours un bundle. La consommation est limitée à quatre bundles par compte émetteur et appareil destinataire sur dix minutes, tous appareils émetteurs et conversations confondus. Ce quota ne protège pas à lui seul contre plusieurs comptes malveillants.
- Protection des sauvegardes SQL et du miroir R2 par l'approbation de la connexion exacte. Un refus SQL remonte une erreur explicite, jamais une liste vide pouvant être interprétée comme l'absence de sauvegarde. Une approbation ne suffit plus si la session Auth a été supprimée ou a dépassé `not_after`.
- Nouveaux jetons d'appel privés soumis à l'approbation de connexion, à l'appartenance actuelle à la conversation et à un appareil non révoqué, non périmé, lié et cryptographiquement valide selon son état enregistré. Les lives publics ne reçoivent pas cette restriction. Cela n'invalide pas rétroactivement un jeton LiveKit déjà émis.
- Le journal de transparence exige une paire Ed25519 persistante cohérente et une clé publique publiée correspondante. Plus de génération de clé de signature éphémère lorsque la configuration manque ; aucune clé privée n'est publiée.

### Vérification et déploiement

Les tests exécutent les politiques et fonctions de préclés/récupération dans PostgreSQL embarqué PGlite. Les primitives de signature du registre et certains services d'authentification y sont des fixtures : ces tests ne remplacent pas l'intégration Cloud. Les gestionnaires Edge de sauvegarde et d'autorisation d'appel sont exécutés avec transports Auth, base et R2 simulés. Les essais WASM utilisent le véritable moteur Libsignal ; les tests d'enveloppe d'appel utilisent X25519, HKDF et AES-GCM réels.

Résultats du 12 octobre : 1 473 tests réussis, 4 ignorés ; 30 tests du serveur Aegis réussis ; 37 tests ciblés d'approbation d'appareil réussis ; essais réels Libsignal WASM réussis dans les six directions entre trois identités ; typecheck, build de production et lint ciblé réussis. Les 37 tests ciblés sont également inclus dans la suite complète, pas à additionner à celle-ci. Le build conserve des avertissements préexistants de taille des bundles et d'imports dynamiques.

Ordre de livraison pour Lovable Cloud, après validation d'une préproduction :

1. Appliquer les migrations `20261012104810`, `20261012105635`, puis `20261012110211`. Conserver la valeur existante de `login_security_config.enforcement_enabled` : aucune activation générale n'est effectuée par ce lot. Si ce drapeau est désactivé, l'exigence d'approbation reste désactivée et ne doit pas être annoncée comme active.
2. Déployer `e2ee-backup-vault` et `livekit-token`, puis le client. Aucun serveur Supabase distinct de Lovable Cloud n'est à créer.
3. Avant de déployer `kt-publish-epoch`, configurer la paire persistante `KT_SIGNING_PRIV_JWK` et vérifier sa correspondance avec la clé publique active existante. Une discordance exige une rotation d'autorité préparée ; ne pas effacer les anciennes têtes signées. Aucun secret de production n'a été créé ou modifié ici.
4. Tester avec deux comptes dédiés : premier appareil, second appareil Windows approuvé depuis iOS, ouverture du lien dans un autre navigateur, retour dans le navigateur initial, PIN, réception hors ligne, reconnexion, vocaux, lecture après restauration et appels audio/vidéo. Ne pas effacer le navigateur d'un client pour faire ce test.

Retour arrière : conserver les contrôles d'identité et les données. Les changements du client et des fonctions Edge ne modifient aucun format ; une version précédente peut être redéployée, après vérification des contrôles serveur. Pour isoler une régression d'appel, utiliser le coupe-circuit existant. Un retrait des politiques ou du quota nécessite une migration corrective ciblée et un arbitrage de sécurité, jamais une suppression des sauvegardes ni une remise à zéro des stores Libsignal. Restaurer l'ancienne définition du routage réintroduirait le défaut de stock vide.

### Écarts de protocole encore ouverts

Ces points restent non corrigés et empêchent de qualifier l'ensemble d'équivalent à Signal :

1. Le quatrième lot ci-dessous raccorde aussi la réception à une attestation publique persistante et vérifiée. La couverture des appareils existants reste à mesurer dans le pilote : un appareil sans attestation signée doit publier sa preuve après mise à jour. Le serveur ne peut pas fabriquer une preuve pour un appareil hors ligne.
2. Le second lot pilote ci-dessous authentifie l'appareil émetteur des invitations d'appel. Les groupes utilisent toujours une clé commune sans rotation à chaque entrée/sortie ; les clés média par émetteur et la révocation des jetons déjà émis restent à traiter.
3. Le relais « sealed sender » actuel ne masque pas l'identité de l'expéditeur de la transaction de message canonique. Le remplacer exige de modifier la livraison authentifiée, les reçus et les contrôles anti-abus, pas simplement le nom d'un événement.
4. La transparence des clés n'a pas encore de vérification complète côté client ni de surveillance indépendante. Une signature persistante ne suffit pas à prouver la cohérence cumulée du journal ; l'écriture actuelle des têtes/feuilles doit aussi devenir atomique.

La mise à jour obligatoire des anciens clients, d'abord en pilote iOS/Windows, a été autorisée. Cette décision ne constitue pas une validation de production ni une autorisation de fusion dans `main`. Aucun contournement silencieux de signature ni nouvelle identité automatique n'est introduit pour masquer un appareil hors ligne.

### Premier lot du pilote de liaison Libsignal

Le client signe le bundle public complet avec la clé Ed25519 existante de l'appareil. Les octets signés incluent le compte, le DeviceID, le numéro Libsignal, le registration ID et le bundle, donc l'identité Libsignal et toutes les préclés. PostgreSQL vérifie la chaîne compte → appareil, la signature, les métadonnées Rust et les droits de la connexion. Le client émetteur vérifie à nouveau la preuve avec l'empreinte exacte du compte ayant autorisé cet appareil, avant l'établissement Libsignal/PQXDH. Un bundle substitué, même valide selon les seules signatures internes de Libsignal, est refusé.

La migration `20261012112352_bind_libsignal_bundles_to_approved_devices.sql` remplace les RPC de publication, d'inventaire et de consommation. Elle ne doit être appliquée qu'au backend du pilote isolé. Les anciens bundles non signés restent comptabilisés pour détecter un store privé perdu, mais ne sont plus consommés par la nouvelle RPC. Le provisionnement recharge le store et la clé de signature existants ; il ne les remplace pas. Aucun format de message, de Master Key ou d'archive n'est modifié.

L'en-tête `x-forsure-messaging-revision: 1` annonce le contrat courant sur REST et sur la passerelle Aegis. La passerelle le relaie sans en inventer un lorsqu'il manque. PostgreSQL refuse les anciens clients sur les RPC de préclés et sur la création de messages/appels. Cet en-tête est un contrôle de compatibilité, pas une attestation de logiciel ni une preuve cryptographique : les signatures et les permissions restent obligatoires. La lecture des messages historiques n'est pas bloquée par ce garde.

Les erreurs `AEGIS_CLIENT_UPDATE_REQUIRED`, `AEGIS_PEER_DEVICE_UPDATE_REQUIRED` et `AEGIS_LIBSIGNAL_BUNDLE_BINDING_INVALID` ne sont plus masquées en simple absence de route. La file conserve le brouillon, affiche le motif et arrête les relances automatiques. Le fan-out attend la fin de ses travaux concurrents avant de refuser l'ensemble, sans publier de copie partielle.

Après ce lot, la suite complète compte **1 530 tests réussis et 4 ignorés** ; le serveur Aegis compte **31 tests réussis**. Les tests dédiés comprennent une signature Ed25519 réelle sur un bundle généré par le WASM livré, puis un échange PQXDH réel avec conservation de l'identité, ainsi que 24 tests PostgreSQL du nouveau contrat. PGlite ne fournit pas pgsodium : sa primitive de vérification admet uniquement des triplets prévalidés par WebCrypto ; la primitive pgsodium réelle reste un critère du pilote Cloud. Les tests d'approbation, le typecheck, le build de production, le contrôle de frontière navigateur et le lint ciblé passent également. Les tests unitaires ne prouvent pas la réussite sur un iPhone physique.

### Conditions du pilote avant généralisation

1. Identifier un projet **Lovable Cloud de test avec une base isolée**. Une URL de preview reliée à la base de production ne suffit pas. Ne copier ni mots de passe ni clés privées de clients pour ces essais.
2. Livrer les trois migrations de durcissement précédentes, la migration de liaison `20261012112352`, celle des invitations signées `20261012115746`, puis celle des attestations persistantes `20261012134736`, la passerelle Aegis et le client correspondants uniquement dans ce pilote. Vérifier pgsodium avec un vecteur Ed25519 positif et un vecteur altéré négatif, puis le CORS REST et passerelle.
3. Avec deux comptes dédiés, tester Safari/PWA iOS et Windows : approbation par email depuis un autre navigateur, retour sur le navigateur initial, PIN, appareil déjà installé, nouvelle session, texte, vocal, réception hors ligne, accusés de lecture et reprise après reconnexion.
4. Tester l'ancien client : l'émission est refusée sans nouvelle ligne de message ; après mise à jour, les clés et l'historique sont conservés. Tester le destinataire sans preuve : un nouveau handshake exige sa mise à jour et l'ouverture de sa messagerie ; aucun bundle non signé de secours n'est accepté.
5. Vérifier la restauration d'un compte de test depuis sa sauvegarde et les messages retardés. Ne pas supprimer les données navigateur d'un client réel. Comparer les empreintes avant/après ; une différence inattendue arrête le pilote.
6. Préparer la couverture des appareils hors ligne avant toute généralisation. Le pilote doit rester fermé si l'accès, le provisionnement ou l'envoi/réception échoue.
7. Terminer les appels en cours avant le changement de client. Une ancienne invitation non signée exige un nouvel appel après mise à jour des deux appareils. Tester les appels audio et vidéo, la sonnerie seulement après vérification, la signature falsifiée, le changement d'identité et l'appareil révoqué, puis le refus micro/caméra. Le coupe-circuit des appels reste indépendant de la messagerie.
8. Pour les applications natives, reconstruire ensemble le moteur Rust, ses en-têtes et le plugin Capacitor. Un ancien binaire ne proposant pas le garde d'identité est refusé à l'envoi par `AEGIS_CLIENT_UPDATE_REQUIRED`, sans repli WASM. Une mise à jour web seule ne suffit pas pour ces binaires ; Safari et les PWA utilisent le WASM reconstruit.

Retour arrière du pilote : arrêter son trafic et revenir à son ensemble client/passerelle/schéma précédent dans **sa base isolée**, sans supprimer de stores ni de messages. Aucun simple retour au vieux client contre la nouvelle migration n'est compatible. En production, un éventuel retour nécessiterait une migration compensatoire relue et testée ; elle n'est pas fournie comme raccourci permettant de retirer les vérifications.

Le pilote n'est pas déployé à ce stade : l'accès Lovable a été confirmé en lecture, mais aucun backend de test isolé n'a été identifié dans les projets consultés. Le vrai Sealed Sender, la rotation des clés d'appel, la validation Cloud de la liaison bidirectionnelle et la transparence cumulative restent les étapes suivantes, pas des garanties acquises par ces lots. La distinction entre identité d'appareil et gestion de session suit le modèle [Sesame de Signal](https://signal.org/docs/specifications/sesame/) ; elle ne certifie pas l'architecture ForSure comme équivalente à Signal.

### Second lot pilote pour les invitations d’appel signées

Les nouvelles invitations portent une signature Ed25519 de la clé existante de l'appareil appelant. La preuve couvre l'identifiant de l'appel, la conversation, le compte et l'appareil appelants, le type audio/vidéo, le mode groupe, le compte et l'appareil destinataires et l'enveloppe complète X25519/HKDF/AES-GCM. La clé média reste aléatoire et n'est jamais signée en clair, publiée au serveur ou remplacée pendant la vérification. Seule la forme signée de l'invitation est acceptée ; aucun repli vers les anciennes invitations non signées.

Le client vérifie la chaîne compte → appareil, l'empreinte exacte du compte et la preuve avant d'afficher la sonnerie, sans ouvrir la clé privée locale à cette étape. Il recommence la vérification à l'acceptation, avant d'ouvrir la clé média. Les métadonnées affichées viennent de l'invitation authentifiée, pas du seul événement Realtime. Le registre canonique refuse également une réponse portant sur un autre identifiant d'appareil ou plusieurs lignes ambiguës. Ce dernier contrôle protège aussi les autres consommateurs du registre, dont les nouveaux établissements de session Libsignal.

La migration `20261012115746_authenticate_call_invitations.sql` ajoute une vérification dans la transaction du RPC de création existant. Chaque enveloppe doit avoir une signature valide de l'appareil approuvé et lié au compte ; une seule invitation invalide annule l'appel et toutes ses invitations. Les champs signés deviennent immuables, tandis que les transitions de statut restent disponibles. Les privilèges des tables ne sont pas élargis. Les lignes historiques sont conservées, mais une invitation ancienne non signée ne permet pas de rejoindre un nouvel appel sécurisé après la mise à jour.

Les tests couvrent le véritable aller-retour Ed25519/X25519/HKDF/AES-GCM client → RPC PostgreSQL → lecture RPC → client, les substitutions de contexte et de clés, les erreurs de signature, l'absence de clé locale, le rejet des anciens clients, l'annulation atomique du fan-out et l'isolation des droits. PGlite exécute les fonctions et triggers réels ; les services d'identité et l'approbation sont des fixtures. Comme pour les bundles, pgsodium est remplacé dans ce banc par des triplets prévalidés avec WebCrypto. La validation pgsodium sur Lovable Cloud, la capture audio/vidéo LiveKit et les essais sur appareils physiques restent nécessaires avant publication.

Ce lot ne fournit pas encore la rotation des clés de groupe ni l'authentification individuelle des flux média de chaque participant. Le format des messages, les sessions Libsignal, les archives et les clés privées existantes ne sont pas réinitialisés. Une régression d'appel reste isolable par le coupe-circuit existant ; ne pas retirer les contrôles de signature en guise de retour arrière.

Validation locale après le second lot, le 12 octobre : **1 598 tests réussis et 4 ignorés** dans 248 fichiers réussis et un fichier ignoré ; **31 tests du serveur Aegis réussis**. Les 30 tests PostgreSQL des invitations, les essais cryptographiques des appels et les tests du registre sont inclus dans la suite complète. Le build, les 37 tests d'approbation, les échanges Libsignal WASM dans six directions, les deux contrôles TypeScript, le contrôle de frontière navigateur et le lint des fichiers modifiés passent. Les avertissements de taille des bundles, d'imports dynamiques et de CSS restent préexistants. Aucune migration distante, fusion ou publication n'a été effectuée pour ce lot.

### Troisième lot pour les identités des sessions sortantes

Chaque envoi vérifie désormais l'approbation actuelle de l'appareil destinataire et l'empreinte du compte, même si une session Libsignal existe déjà. La preuve signée du bundle est conservée dans le coffre, séparément des clés privées, avec une portée exacte compte local, appareil local, compte distant et appareil distant. Sa signature et son numéro d'appareil sont revérifiés à chaque utilisation. Après le premier contrôle, les envois sur une session valide ne consomment plus de préclé supplémentaire.

Le garde Rust compare l'identité publique canonique de 33 octets avec l'identité connue et celle de la session active. Une divergence est refusée, sans effacer ni remplacer le store. Le pin d'identité est placé dans une copie de travail avant l'opération ; le bridge persiste uniquement le store final après réussite du chiffrement ou déchiffrement, sous le même verrou. Le format de message, le format du store et l'ABI existante restent inchangés ; une nouvelle fonction additive et une capacité native explicite portent le contrôle.

Une session antérieure sans preuve locale demande un bundle signé, contrôle son identité contre le ratchet existant puis réutilise ce ratchet s'il correspond. Elle ne lance un nouveau handshake qu'en l'absence de session. Une identité substituée, un appareil révoqué, un coffre illisible ou une preuve invalide ne sont jamais interprétés comme un motif pour générer de nouvelles clés. Un refus d'identité de session remonte jusqu'à la file d'envoi, bloque la publication de copies partielles et conserve le brouillon avec une erreur visible.

À la fin du troisième lot, la fonction de réception contrôlée était testée avec le moteur réel, mais son runtime n'était pas encore raccordé à une preuve persistante. Le quatrième lot ci-dessous réalise ce raccordement sans consommer une préclé à chaque réception ni bloquer l'historique sur l'état présent d'un ancien appareil.

Les essais fonctionnels du client utilisent la vraie signature Ed25519, le vrai WASM, le vrai runtime sortant et la persistance simulée du coffre ; le registre Cloud et les verrous inter-onglets sont simulés dans ce banc. Ils couvrent premier envoi, réutilisation, mise à niveau d'une session avec message retardé, substitution d'identité et révocation. Les tests séparés des bridges contrôlent l'ordre sous verrou, le refus des anciens plugins et l'absence de commit intermédiaire. Les tests Rust et l'interopérabilité DLL Windows/WASM utilisent le moteur compilé depuis les sources modifiées. Le contrôle Android Rust/JNI compile ; la compilation de l'application iOS, les essais sur appareils physiques et le pilote Cloud restent obligatoires.

Validation locale après le troisième lot, le 12 octobre : **1 655 tests réussis et 4 ignorés**, dans 251 fichiers réussis et un fichier ignoré ; **31 tests du serveur Aegis** et **13 tests Rust réussis**. Les échanges réels DLL Windows/WASM passent dans les deux sens avec refus des substitutions d'identité. Le contrôle croisé Rust/JNI pour Android passe ; il ne constitue pas un test de l'application Android. Le build de production, les 37 tests d'approbation inclus dans la suite, les échanges WASM dans les six directions, les deux contrôles TypeScript, le contrôle de frontière navigateur et le lint ciblé passent également. Les avertissements de taille des bundles, d'imports dynamiques et de CSS restent préexistants. Aucune migration distante, fusion ou publication n'a été effectuée pour ce lot. Ces résultats ne valident pas encore la réception complète ni un parcours sur iPhone physique.

### Quatrième lot pour les identités à la réception

La migration `20261012134736_persist_libsignal_receive_attestations.sql` conserve une attestation publique signée indépendante du stock de préclés. Sa capture vérifie la chaîne compte → appareil → bundle ; une autre identité Libsignal sous le même identifiant d'appareil est refusée. La table n'est pas directement accessible aux clients. La RPC exige une connexion autorisée et une version compatible ; elle fournit la preuve au propriétaire ou à un véritable destinataire d'une copie de message dont l'auteur correspond au message parent. Elle ne dépend pas d'une relation d'amitié.

Le runtime entrant vérifie cette chaîne, l'empreinte connue et l'identité Libsignal avant le déchiffrement. Il conserve la preuve dans le coffre avec lecture de contrôle avant toute consommation de préclé. Les réceptions suivantes revérifient la preuve locale sans requête de préclé. Une preuve absente ou invalide est un refus explicite, jamais une acceptation automatique d'une identité inconnue. La preuve historique reste disponible après révocation de l'appareil distant : cela permet de lire les messages déjà reçus, sans autoriser de nouveaux envois depuis cet appareil.

Le rattrapage ne peut utiliser que des bundles déjà signés et des appareils encore valides. Les appareils sans bundle signé disponible doivent rouvrir une version mise à jour pour publier leur preuve. Mesurer cette couverture et vérifier la restauration depuis un coffre vide restent des prérequis du pilote ; ne pas généraliser cette migration sans eux.

Validation locale du 12 octobre après ce lot : **1 674 tests réussis et 4 ignorés**, dans **252 fichiers réussis et un ignoré**. Les 68 tests ciblés de liaison et de réception sont inclus dans cette suite. Ils couvrent le faux premier expéditeur, les signatures altérées, les substitutions de contexte, le coffre indisponible, les préclés épuisées, les accès non autorisés et les messages retardés. Les essais client utilisent WebCrypto et le véritable WASM ; Auth, RPC et coffre sont simulés. PGlite exécute les fonctions SQL avec les vecteurs de signature prévalidés, pas la primitive pgsodium Cloud. Le build, les deux contrôles TypeScript, les 37 tests d'approbation, les échanges WASM et le lint ciblé passent. Les avertissements de build préexistants demeurent.

Aucune migration distante, fusion ou publication pour ce lot. Les tests physiques iOS/Windows, le pilote Lovable Cloud isolé, le véritable Sealed Sender, la rotation des clés des appels de groupe et la transparence cumulative complète restent à terminer. Ces contrôles d'identité ne prouvent pas à eux seuls la résolution du parcours d'approbation par email.
