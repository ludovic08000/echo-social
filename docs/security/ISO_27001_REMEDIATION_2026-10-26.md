# ForSure — corrections et dossier de travail du SMSI

Date : 26 octobre 2026. Statut : **préparation locale, approbation de la direction en attente**.
Ce dossier ne constitue ni une certification ni une déclaration de conformité. Il complète le
[pré-audit et ses preuves](ISO_27001_PREAUDIT_2026-10-26.md), sans réécrire ses observations historiques.

## 1. Ce qui est corrigé dans ce lot

- Mises à jour compatibles du lockfile : notamment `proxy-addr` 2.0.8, XML, parseurs HTTP,
  WebSocket, PostCSS et outils de développement. Pas de downgrade Capacitor, de remplacement
  du SDK MCP, de modification des clés ou des formats Aegis/Libsignal.
- Test ajouté avant la correction de `proxy-addr` : échec constaté sur 2.0.7, succès sur 2.0.8.
- Migration contrôlée de Vitest vers 4.1.12 (outil de test uniquement, sans le pool vulnérable)
  et de Zod vers 4.6.7 (versions acceptées par les SDK). Adaptation de l'API d'erreur d'URL
  `errors` vers `issues`, couverte par un test rouge puis vert. Les types Node et ES2022
  auparavant apportés indirectement par Vitest sont maintenant explicites ; le JavaScript
  cible reste ES2020 et aucun contrôle de types n'a été désactivé.
- Pages d'information corrigées : session web dans localStorage, sauvegardes de clés chiffrées,
  limites de l'effacement, prestataires Cloud réels, personnalisation publicitaire facultative.
  Les changements de texte ne modifient ni le consentement enregistré, ni les accès, ni les règles d'âge.
- Sonde de disponibilité en lecture seule : HTML, service Auth avec clé **publique**, CORS,
  version publiée et en-têtes HTTP effectifs. Une réponse 401/521/503 du service Auth est un échec,
  pas une preuve que le backend fonctionne. Sans version attendue, aucune livraison n'est déclarée vérifiée.
- Porte de contrôle CI : inventaire CycloneDX et échec explicite pour les dépendances élevées/critiques.
  Les trois actions de ce nouveau workflow sont épinglées sur des SHA officiels vérifiés,
  avec permissions de lecture et sans exécution des scripts d'installation des dépendances.
  Ce contrôle n'est pas une attestation ISO et ne rend pas obligatoire la règle de protection GitHub
  à lui seul : le propriétaire doit configurer le contrôle requis avant fusion.

La liste chiffrée des tests, le build et les alertes résiduelles sont consignés dans le
[résultat de vérification du lot](ISO_27001_REMEDIATION_2026-10-26.results.json).

Validation finale : **2 066 tests réussis, 0 échec, 1 test optionnel ignoré**, dans 296 fichiers,
sous Vitest 4.1.12 ; **37 tests Aegis réussis** ; **6 sens d'échange Libsignal WASM réussis** ;
TypeScript, lint ciblé et build complet réussis. Le test Python de géolocalisation qui avait
dépassé son délai dans une exécution concurrente a repassé isolément puis dans la suite complète
à un worker, sans augmenter son délai ni l'ignorer. Le build conserve des avertissements de
taille des chunks et de bundling ; aucun lint global ni test mobile signé n'est revendiqué.

Build local : `1793031149102`, daté du 26 octobre à 16:12:29 UTC. À 16:13:34 UTC, le site
servait encore `1792045424013` ; Auth health/settings répondaient 200 mais l'anti-frame HTTP
restait absent. **Aucune fusion, publication ou migration Cloud n'a été effectuée dans ce lot.**

État des dépendances après ces corrections, audit de l'arbre complet incluant le développement :
**0 critique, 0 élevée, 11 modérées au dernier relevé**. Un relevé précédent de ce même lot
comptait 14 modérées ; les résultats sont des instantanés du registre, pas une constante du produit.
Les alertes modérées concernent notamment React Router,
les parseurs CSS et des outils de compilation native/développement. Elles restent ouvertes :
aucun effacement du rapport ni exception silencieuse. La porte CI actuelle bloque les niveaux
élevé/critique ; un passage de cette porte ne signifie pas absence de risque ni certification.

La première tentative de tests Vitest 4 a rencontré une restriction de renommage dans le
répertoire temporaire du sandbox Windows (EPERM, aucun test exécuté). La relance utilise un
répertoire temporaire dédié dans le workspace, sans modifier le code applicatif ou assouplir
le sandbox. Une tentative initiale de build a aussi relevé l'ancienne API Zod et les types
auparavant implicites ; ces incompatibilités ont été corrigées avant la validation finale.

## 2. Conditions de livraison — non satisfaites par le seul build

1. Conserver la [séquence de migration du lot précédent](SECURITY_FIX_ROLLOUT_2026-10-18.md).
   Ne pas retirer les privilèges de colonnes avant le client compatible.
2. Valider paiements, visibilité des posts privés, abonnements, photos de profil/couverture,
   notifications, feed, appels et envoi/réception multi-appareils sur un environnement isolé.
3. Traiter ou faire examiner les alertes de dépendances restantes, y compris les outils de test.
   Aucune exception de risque n'est acceptée implicitement par ce document.
4. Appliquer l'anti-frame **au serveur qui sert le HTML Lovable**, et tester le résultat HTTP.
   Une balise HTML, un fichier `_headers` non pris en charge ou les en-têtes du seul serveur Aegis
   ne clôturent pas cet écart. Préserver séparément la prévisualisation Lovable autorisée.
5. Faire valider les notices et l'inventaire contractuel par le responsable du traitement.
6. Autorisation explicite avant fusion dans main et livraison des changements sensibles.
7. Après publication : comparer la version réellement reçue, puis vérifier les droits anonymes,
   propriétaire et tiers. Aucun retour arrière ne doit réouvrir une fuite de données.

## 3. Politique de sécurité proposée — décision de la direction requise

Périmètre proposé : développement et exploitation de ForSure (web, applications mobiles,
API Aegis, Lovable Cloud, données publiques et privées, paiements, administration, support,
fournisseurs et accès GitHub). Les exclusions et interfaces doivent être justifiées ;
R2 n'est pas exclu du risque parce que son chantier technique est différé.

Objectifs : confidentialité des messages et des clés ; intégrité des identités et paiements ;
disponibilité de la connexion ; traitement fiable des demandes de droits ; livraisons traçables
et réversibles. Le réseau social doit conserver ses usages publics légitimes : lecture des
publications publiques, médias, profils autorisés et découverte ne deviennent pas privés par défaut.

La direction doit approuver le périmètre, les critères de risque, les moyens et les objectifs
mesurables. **Approbation : non obtenue ; responsable nominatif : à désigner.**
Examiner aussi les besoins des parties intéressées et la pertinence du changement climatique
dans le contexte de l'organisme, selon l'amendement 2024 ; aucune conclusion n'est présumée.

### Responsabilités à attribuer

| Rôle | Responsabilité / preuve attendue | État |
| --- | --- | --- |
| Direction | Périmètre, budget, acceptation des risques, revue de direction | Nominatif et validation attendus |
| Responsable sécurité | Registre des risques, incidents, revues d'accès, preuves | À désigner |
| Exploitation / suppléant | Alertes Cloud, restauration, astreinte, disponibilité | À désigner |
| Responsable du traitement | Registre, droits, fournisseurs, transferts, analyse d'impact | À confirmer |
| Responsable des livraisons | Tests, autorisation, version servie, retour arrière | À désigner |
| Auditeur interne impartial | Programme d'audit, constats et suivi | À désigner, indépendance à vérifier |

Ne pas inscrire une personne, une formation, un contrat ou un audit comme effectué sans preuve.

## 4. Registre initial de risques et plan de traitement

Méthode proposée : vraisemblance et impact de 1 à 5, score = produit. L'impact considère les
personnes, l'activité, la confidentialité, l'intégrité et la disponibilité. Ces critères et
les seuils d'acceptation restent **à approuver**. Les valeurs ne sont pas inventées ici.

| Risque / lien pré-audit | Traitement / critère de clôture | État réel |
| --- | --- | --- |
| FS-01/02 Autorisations et paiements en production | Migration ordonnée, tests positifs/négatifs, version et privilèges Cloud attestés | Corrections locales antérieures ; livraison non attestée |
| FS-03 Dépendances | Correctifs compatibles, inventaire par artefact, avis restants analysés et corrigés ou décision datée | Lot local ; alertes résiduelles non acceptées |
| FS-04 Suspension / crédits Cloud | Alertes existantes vérifiées, responsable, seuils et budget approuvés, test d'alerte | Sonde prête ; alertes/astreinte non attestées |
| FS-05 Perte de données / restauration | Sauvegardes DB + médias + configuration, restauration isolée mesurée | Sauvegardes DB vues ; exercice non réalisé |
| FS-06 Gouvernance | Politique, périmètre, responsabilités, registre et déclaration d'applicabilité approuvés | Dossier de travail, pas approbation |
| FS-07 Accès administratifs | Inventaire des accès et MFA, enrôlement et secours testés avant enforcement | Pas de verrouillage AAL2 ajouté à l'aveugle |
| FS-08/09 Vie privée, IA et mineurs | Notices exactes, registre, contrats/régions, durées et analyse d'impact examinés | Textes locaux corrigés ; validation et contrats attendus |
| FS-10 Clickjacking | CSP frame-ancestors HTTP sur le vrai hébergeur, test positif/négatif | Non clos ; aucun faux correctif HTML |
| FS-11 Traçabilité | Vérifier les jobs de purge Aegis existants, intégrité et accès des journaux | Purge programmée déjà présente ; exécution à attester |
| FS-12 Garanties cryptographiques | Conserver protocole, vérifier multi-appareils, examiner ancrage indépendant de transparence | Pas de changement de protocole dans ce lot |
| FS-13 Médias R2 | Examiner URLs privées, purge, quota et validation des uploads | Chantier différé à la demande ; risque encore ouvert |

Pour chaque risque : ajouter un propriétaire, une évaluation initiale, un traitement choisi,
une échéance, une preuve de réalisation et une évaluation résiduelle ; seule une personne
autorisée peut accepter explicitement un risque résiduel, avec date et date de réexamen.

### Déclaration d'applicabilité à compléter

Ce tableau n'est **pas** la déclaration d'applicabilité complète des 93 mesures de l'annexe A.
Rapprocher les mesures du texte ISO sous licence et justifier chaque inclusion/exclusion.

| Famille indicative | Justification / preuve à joindre |
| --- | --- |
| A.5.15–5.18, A.8.2–8.3 : accès | Réseau social multi-utilisateurs, rôles admin, RLS, sélections publiques et revues d'accès |
| A.5.19–5.23 : fournisseurs / cloud | Lovable Cloud, Aegis/Vercel, médias, paiement, IA, e-mail et notifications |
| A.5.24–5.28 : incidents | Journaux corrélés, gestion des preuves et procédure ci-dessous |
| A.5.29–5.30, A.8.13 : continuité | Disponibilité Auth et exercice de restauration complet |
| A.5.31–5.34 : exigences / données personnelles | Registre, droits, contrats, traitement des demandes et analyse d'impact à examiner |
| A.6 : personnes | Recrutement, sensibilisation, confidentialité, départ et retrait des accès à documenter |
| A.7 : physique | Répartition des responsabilités fournisseur / postes de travail à examiner, pas d'exclusion automatique |
| A.8.8, A.8.25–8.32 : développement | SCA, tests, environnements isolés, CI, revue et livraisons approuvées |
| A.8.15–8.16 : journaux / supervision | Date UTC, source serveur/client, absence de secrets, intégrité, purge et alertes testées |

## 5. Procédure incident et disponibilité

1. Qualifier l'incident : indisponibilité Auth/Cloud, erreur applicative, fuite de données,
   usurpation, paiement ou perte de clés. Horodater en UTC, conserver le fuseau utilisateur.
2. Consigner uniquement métadonnées utiles, code d'erreur, trace et version. Ne pas copier
   mots de passe, jetons, liens d'approbation complets, clés privées ou contenu E2EE dans les logs.
3. Comparer HTML et Auth ; un HTML 200 ou un Auth 401 sans clé publique ne suffit pas.
   Utiliser `npm run verify:service-readiness` avec la clé publique fournie par l'environnement,
   et `EXPECTED_BUILD_VERSION` pour vérifier une livraison. Aucun identifiant client requis.
4. Si Cloud indisponible : vérifier DNS, statut du projet, consommation, limites et alertes
   dans Lovable Cloud. Réactivation dans l'éditeur si indiquée par Lovable. Ne pas modifier
   les domaines autorisés, désactiver TLS, supprimer le navigateur ou recréer les clés pour
   masquer une panne. Ne pas augmenter un budget sans décision de la direction.
5. En cas d'accès non autorisé : contenir sur le compte, la session ou l'endpoint concernés,
   préserver les preuves, ne pas désactiver globalement la sécurité. Examiner la nécessité
   des notifications aux personnes/autorités avec le responsable compétent et les délais applicables.
6. Reprise : tester compte synthétique, droits positifs/négatifs, état serveur exact de
   l'appareil, envoi/réception et ancien historique. Une approbation perdue côté navigateur
   ne signifie pas un refus ; elle doit être relue côté serveur.
7. Rapport : début, détection, cause confirmée ou inconnue, impact, actions, preuve de reprise,
   communication, actions préventives et propriétaire. Revue après incident, sans clôture fictive.

La sonde est une commande manuelle, **pas une surveillance externe déjà déployée**.
Fréquence, canal d'alerte, destinataire et escalade doivent être choisis puis testés.

## 6. Plan de sauvegarde et exercice de reprise sans toucher à la production

Les sauvegardes DB Lovable observées ne couvrent pas les fichiers de stockage. Voir
[la documentation Lovable](https://docs.lovable.dev/features/database-backups) et
[les recommandations CNIL](https://www.cnil.fr/fr/securite-sauvegarder).

| Élément | Ce qu'il faut préserver / vérifier |
| --- | --- |
| Base Cloud | Schéma, fonctions, politiques, données, correspondance des identités et contraintes |
| Médias | Objets de stockage/R2, règles public/privé, métadonnées et cohérence des références |
| Coffres E2EE | Enveloppes déjà chiffrées, versions et liaisons compte/appareil ; aucune extraction de clés en clair |
| Code et dépendances | SHA autorisé, lockfile, artefacts signés ou hachés et inventaire de dépendances |
| Configuration | DNS, domaines de redirection, jobs, fonctions, paramètres fournisseurs et secrets dans un coffre distinct |

RTO/RPO : **à décider par activité**, pas de valeurs atteintes revendiquées. Mesurer le besoin
de la messagerie, des paiements et de la publication ; l'intervalle constaté entre deux sauvegardes
n'est pas un engagement contractuel. Définir copies isolées/hors ligne, chiffrement et accès.

Exercice : identifier un environnement jetable réellement isolé et son propriétaire ; disposer
d'une copie autorisée/minimisée ; bloquer l'envoi de mails, push et paiements réels ; restaurer
sans réutiliser des secrets de production ; tester droits, références médias et continuité de
comptes synthétiques ; mesurer pertes et temps ; conserver rapport d'intégrité et écarts.
**Ne jamais cliquer sur « Restore » du projet de production pour tester ce plan.**
Le test n'a pas été réalisé dans ce lot ; l'environnement, la copie et l'opération de restauration
doivent faire l'objet d'une autorisation précise.

## 7. Retour arrière

Avant ce lot, les manifests déjà modifiés ont été copiés dans
`.tmp/iso-remediation-20261026-before-dependencies/`. Cette copie locale n'est ni une
sauvegarde indépendante ni un retour arrière de la base. Ne pas remplacer les changements
antérieurs appartenant à l'utilisateur par un checkout forcé.

Pour un retour arrière logiciel : choisir un artefact compatible testé, préserver les
corrections de droits et de paiements, vérifier la compatibilité du schéma, obtenir l'accord
de livraison, comparer ensuite la version servie et refaire les tests de non-régression.
Un retour vers une dépendance vulnérable nécessite une nouvelle analyse ; il n'est pas la
procédure normale de traitement d'une régression.

Revue React : les changements des pages restent des corrections d'information et de liens ;
aucun effet, abonnement réseau ou mécanisme d'authentification n'a été ajouté dans ces composants.
Le backend reste Lovable Cloud, conformément au périmètre et aux règles de déploiement existantes.

## 8. Étapes humaines nécessaires avant certification

Faire approuver périmètre/politique/responsables, compléter l'applicabilité avec le référentiel
licencié, produire contrats et registre, examiner analyse d'impact et protection des mineurs,
tester MFA et secours, exercer reprise et réponse incident, former les intervenants,
réaliser un audit interne impartial puis une revue de direction et fermer les écarts.
L'audit de certification doit être conduit par l'organisme choisi : le code et ce dossier
ne peuvent ni certifier l'organisation ni remplacer ses preuves de fonctionnement.
