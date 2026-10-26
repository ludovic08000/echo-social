# ForSure — frontière API du feed

Date : 26 octobre 2026. Implémentation locale ; aucune publication ni migration Cloud dans ce lot.
Ce travail complète le dossier ISO, sans constituer une certification ou une preuve de conformité.
Il ne modifie pas les clés, l'approbation des appareils, Aegis, Libsignal, l'authentification du site,
les poids du moteur ou le choix de l'utilisateur entre amis, découverte, actualités et marketplace.

## Parcours et périmètre

Le classement était déjà calculé côté serveur. Le navigateur principal appelait directement
`get_ranked_feed_page`, `ml_ingest_feed_events` et la table des préférences. Désormais, ces trois
parcours passent par une fonction **Lovable Cloud** `feed-api`, avec cinq opérations explicites :

| Opération | Accès | Fonction |
| --- | --- | --- |
| `page` | Session vérifiée ou visiteur public | Page, curseur opaque, médias et preuves d'exposition |
| `events` | Session vérifiée | Télémétrie bornée, consentement et anti-rejeu vérifiés en base |
| `preferences.read` | Session vérifiée | Choix du compte connecté uniquement |
| `preferences.write` | Session vérifiée | Enregistrement validé des choix |
| `preferences.seed` | Session vérifiée | Migration initiale du cache, sans écraser une ligne existante |

Les appels utilisent le JWT du lecteur et ses droits. Le rôle service ne sert qu'au quota persistant ;
il ne lit pas les publications ou préférences. Le client n'impose ni identifiant de lecteur,
ni nom de fonction SQL, ni score, ni variante expérimentale, ni poids d'événement.
L'API ne renvoie pas `final_score`, `rank_reason`, `experiment_variant` ou de nouveau champ interne
ajouté ultérieurement : les champs publics sont explicitement sélectionnés.

Les publications de profil, réactions, commentaires, médias partenaires, messages et autres surfaces
conservent leurs interfaces existantes. L'inscription conserve aussi son écriture initiale historique
des centres d'intérêt ; elle reste soumise aux droits serveur existants. Ce lot ne prétend pas migrer
toutes les API du réseau social ou modifier le parcours de création de compte.
Les anciennes fonctions SQL compatibles restent accessibles selon leurs droits existants :
la nouvelle projection n'est donc **pas une garantie de confidentialité de tous les anciens résultats**.
Leur retrait exige un inventaire complet des consommateurs et une livraison séparée compatible.

## Contrôles introduits

- Token validé par Auth, jamais déduit d'un simple décodage JWT. Un token invalide n'est pas
  transformé en visiteur anonyme ; une panne Auth temporaire devient une indisponibilité 503,
  pas une déconnexion ni une suppression de session.
- Renforcement serveur ajouté ensuite : chaque opération authentifiée vérifie également
  `feed_api_session_active()` sous le JWT du lecteur. La session doit exister dans `auth.sessions`,
  appartenir à `auth.uid()` et ne pas avoir dépassé `not_after`. La fonction ne reçoit aucun
  identifiant fourni par le client et ne renvoie qu'un booléen. Les visiteurs publics ne l'appellent pas.
  Session absente/révoquée = 401 ; réponse inconnue, RPC manquante ou panne = 503, jamais un repli
  permissif. Les résultats positifs ne sont pas mis en cache et aucune nouvelle approbation d'appareil
  n'est demandée. Seul `authenticated` peut exécuter cette fonction SECURITY DEFINER à `search_path`
  vide ; les tables Auth ne deviennent pas lisibles par le navigateur.
- CORS existant conservé pour `forsure.fans`, son domaine `www` et les prévisualisations autorisées.
  Origines natives exactes ajoutées uniquement à cette API. CORS ne remplace pas l'autorisation.
- Méthodes POST/OPTIONS, JSON UTF-8, lecture en flux limitée à 64 Kio, au plus 50 publications
  ou 100 événements par appel. Délai serveur de 10 s et annulation propagée aux requêtes amont.
- Quota persistant : 120 pages/minute et 60 appels/minute pour les événements ou les préférences.
  Échec du quota = refus temporaire, jamais un contournement. Un plafond global de 600 pages/minute
  pour les visiteurs ne dépend d'aucun en-tête client ; une rotation d'IP déclarée ne le contourne pas.
  Ce plafond peut limiter tous les visiteurs sous charge et doit être dimensionné avant ouverture
  à grande échelle ; il ne remplace pas une protection réseau anti-DDoS. Pour le quota secondaire
  par IP, l'intégrité des en-têtes dépend du nettoyage par la passerelle Cloud et reste à vérifier.
  Le hachage de l'IP utilisé pour ce quota n'est pas présenté comme une anonymisation.
- Erreurs publiques finies, sans SQL ni détail fournisseur ; identifiant de requête et `no-store`.
- Curseurs serveur inchangés, liés au lecteur, avec contrôle de visibilité entre les pages.
  Les preuves d'exposition, le consentement et l'idempotence de la télémétrie restent côté SQL.
- Le client capture la session attendue : pas de réponse du nouveau compte mise dans le cache
  de l'ancien. Les préférences sont fusionnées avec la ligne serveur du bon compte, pas un cache tiers.
- Aucun repli automatique vers l'ancienne RPC si l'API échoue : une indisponibilité reste visible.

## Métadonnées publiques et limites

Le réglage officiel **Hide Lovable badge** a été constaté actif dans les paramètres du projet.
Il n'a pas été modifié. Le build conserve la minification et l'absence de source maps ; les fichiers
JavaScript ont des noms neutres. Le nouveau contrôle `verify:public-build` refuse les `.map`,
références de source maps et marqueurs d'instrumentation de l'éditeur dans le résultat public.
Les licences et les informations légales sur les prestataires ne sont pas supprimées.

Cela ne rend pas l'architecture indétectable. Le JavaScript exécuté, les requêtes réseau, les domaines
Cloud utilisés par Auth/Storage et certaines dépendances restent observables. Multiplier les API
n'apporterait pas de protection en soi. Un domaine API ForSure nécessiterait une passerelle ou une
configuration de domaine supplémentaire, avec tests DNS/TLS/CORS ; rien de cela n'a été configuré ici.

## Vérifications

- Tests HTTP du vrai handler, adaptateur Cloud avec fournisseur simulé, client API, hook React Query,
  préférences et contrôle du build public : **45 tests ciblés réussis**, également inclus dans la
  dernière suite complète. Un premier test de pagination attendait la réponse réseau mais pas la
  notification React Query ; il a été corrigé pour attendre le rendu effectif, sans modifier la pagination.
- PostgreSQL isolé : **70 vérifications réussies**, dont HTTP → handler réel → SQL réel pour
  pagination, blocage entre pages, absence de doublons, exposition, anti-rejeu et retrait du consentement.
  Auth et quota sont des fixtures dans ce test SQL ; il ne constitue pas un test de production.
- Dernière suite complète, de 16:48:51 à 16:54:48 UTC : **2 111 tests réussis, 0 échec,
  1 test optionnel ignoré, 302 fichiers**. Le test ignoré compare la base City Lite originale
  en dix langues ; son jeu de données externe n'est pas fourni. Aucun test du feed ajouté ici n'est ignoré.
- Contrôle Deno de la fonction Cloud, TypeScript de l'application, lint ciblé et build de production
  réussis. Le build inclut **37 tests d'approbation des appareils** et les **6 sens d'échange du vrai
  WASM Libsignal**, puis les contrôles de frontière Aegis/PWA/MCP et du build public.
- Build local `1793033256055`, généré le 26 octobre à 16:47:36 UTC. Les avertissements de bundling,
  taille de chunks, PostCSS et classe Tailwind préexistants restent présents ; aucun lint global sans
  avertissement n'est revendiqué. Le dernier ajustement du quota est côté serveur uniquement,
  couvert ensuite par Deno et la suite complète finale.

Les [résultats et empreintes de ce lot](FEED_API_BOUNDARY_2026-10-26.results.json) identifient les
principaux fichiers vérifiés. Le rapport Vitest brut est conservé localement dans
`.tmp/feed-api-final-regression-20261026.json` ; ne pas publier le dossier temporaire en bloc.

Les tests locaux ne mesurent ni la latence du Cloud, ni sa configuration effectivement livrée.
L'API ajoute une étape réseau et une vérification Auth : la cible 200–350 ms doit être mesurée,
notamment à froid et sur mobile. Aucun gain de latence n'est revendiqué dans ce lot.

### Portée du renforcement de session

La nouvelle vérification s'applique aux cinq opérations de `feed-api`, pas aux autres API ni aux
anciennes RPC encore accessibles. Elle ne remplace pas leurs règles d'autorisation, les contrôles
d'approbation de connexion ou les restrictions de visibilité. Elle ne bloque pas un feed valide
parce que le coffre de messagerie n'est pas encore prêt.

Le contrôle a lieu avant les opérations de contenu, dans une requête SQL distincte. Une opération
déjà autorisée/en cours au moment d'une révocation n'est pas rétroactivement annulée ; la requête
suivante est refusée. La durée maximale stockée dans `not_after` est vérifiée, mais aucune nouvelle
politique d'inactivité n'est créée. Ne pas présenter ce contrôle comme une fermeture globale de
tous les accès avec d'anciens JWT, ni comme une garantie contre le vol d'une session encore active.

La migration additive `20261026170313_feed_api_active_session_authority.sql` ne supprime ni ne
modifie aucune session, aucun compte, aucune clé ou donnée de feed. Un test isolé vérifie sa
réexécution. Le contrôle ajoute un aller-retour en base, à inclure dans les futures mesures p95
du Cloud ; ne pas ajouter un cache de validation qui retarderait la prise en compte des révocations.
Les empreintes et résultats de la première série ci-dessus restent des preuves historiques :
les nouveaux résultats de session doivent être lus séparément.

Résultats du renforcement serveur, obtenus après les modifications : **2 136 tests réussis,
0 échec, 1 test externe optionnel ignoré, 303 fichiers**, de 17:05:28 à 17:09:56 UTC.
Les 70 tests ciblés comprennent 14 tests PostgreSQL du contrôle de session ; 25 tests ont été
ajoutés depuis le premier lot. Les 70 vérifications SQL/HTTP du feed passent également.
TypeScript, Deno, lint ciblé et build de production passent, avec les mêmes avertissements
de bundling ; 37 tests d'approbation et les 6 directions du vrai WASM Libsignal passent dans
le build. Version locale `1793034638330`, générée à 17:10:38 UTC, **non déployée**.
Les [preuves et empreintes du contrôle serveur](FEED_API_SESSION_AUTHORITY_2026-10-26.results.json)
distinguent les tests isolés des validations Cloud restant à effectuer.

## Réduction de l'exposition publique — lot du 26 octobre

Ce lot reste **local, non publié**. À 17:23:44 UTC, `forsure.fans` servait encore
`FORSURE-AUDIT-COMPLET.txt` et `reset-cache.html` en HTTP 200 avec leur contenu historique.
La version publique relevée était `1792045424013`, générée le 15 octobre à 06:23:44 UTC.
Les résultats de session ci-dessus concernent le lot précédent, pas une publication.

Changements limités à la surface publiée et à ses contrôles :

- L'ancien audit détaillant l'architecture est archivé dans
  `docs/security/archives/FORSURE-AUDIT-COMPLET-2026-03-08.txt`, hors du dossier `public`.
- L'ancienne page autonome `reset-cache.html`, non référencée par l'application, est conservée
  sous `docs/security/archives/reset-cache-legacy.html.txt`. Elle modifiait des identifiants
  locaux, la session et les caches dès son chargement. Elle n'a pas été exécutée pendant
  cette intervention. Aucune donnée de navigateur n'a été effacée.
- `llms.txt` décrit les fonctions du produit sans inventaire de l'implémentation, sans retirer
  les liens légaux ni les informations nécessaires sur les prestataires.
- Les noms des ressources générées par Vite deviennent neutres ; les chemins des ressources
  statiques, identités de cache PWA et formats Aegis/Libsignal restent inchangés.
- Le contrôle de build refuse les sources serveur, configurations, audits internes, anciennes
  pages de maintenance, sourcemaps, instrumentation d'éditeur et certains formats connus de
  secrets privilégiés. Ce contrôle n'est pas un scanner exhaustif de secrets ou de tout l'historique Git.
  Il accepte les clés publiques applicatives, les notices de licence et les constantes PEM sans clé.

Le navigateur reste capable d'inspecter le JavaScript, les appels réseau et les ressources dont
il a besoin. Des noms neutres ou un dépôt privé ne remplacent ni l'autorisation serveur ni le
chiffrement. Aucun anti-debug, masquage des erreurs de sécurité, changement de protocole ou
migration de clés n'a été ajouté. Les copies déjà téléchargées ne peuvent pas être rappelées.

Les [preuves de ce lot](PUBLIC_ARCHITECTURE_BOUNDARY_2026-10-26.results.json) enregistrent :
**2 140 tests réussis, 0 échec, 1 test externe optionnel ignoré**, TypeScript et lint ciblé
réussis, build de production réussi avec les avertissements préexistants. Les 37 tests
d'approbation et les 6 directions d'échange du vrai WASM Libsignal passent. Les deux fichiers
historiques sont absents de `dist` ; les 226 références locales de ressources contrôlées
existent. Les contenus originaux des archives sont conservés. Version locale
`1793035568672`, générée à 17:26:08 UTC. Aucun test sur appareils physiques ni parcours
multi-compte de production n'est revendiqué. Le build contient aussi les changements API
précédents : ne pas le publier avant leurs validations Lovable Cloud distinctes.

### Préparation du dépôt privé : pas de bascule effectuée

La [préparation enregistrée](REPOSITORY_PRIVACY_PREFLIGHT_2026-10-26.json) distingue faits vérifiés
et prérequis. GitHub déclare le dépôt public, sans GitHub Pages ni forks visibles. Dans les
paramètres Lovable, le projet `Echo Social` est relié à `ludovic08000/echo-social`, branche `main`,
avec les états « Connected » et « In sync with GitHub ». Le badge est déjà masqué, le remix
public et le Trust center public sont désactivés. Aucun de ces réglages n'a été changé.

L'accès administrateur GitHub manque dans cette session : collaborateurs, sélection des dépôts
des GitHub Apps, protections de branche et effet du forfait sur les outils de sécurité restent
à vérifier. La [documentation Lovable](https://docs.lovable.dev/integrations/github) prévoit
des dépôts privés ; cela ne prouve pas les permissions actuelles de cette installation.

Le projet déclare `AGPL-3.0-only` dans `LICENSE` et `package.json` et contient des adaptations
Signal Desktop et libsignal. `EncryptionBadge.tsx` propose le dépôt actuel comme source Aegis.
Avant de le rendre privé, établir et tester une offre de code source correspondant à la version
servie, avec notices et sources de construction requises. Une possibilité à examiner est un
dépôt de développement privé et des sources de versions publiées séparément ; ne pas présumer
que publier uniquement la bibliothèque libsignal suffit. Les [termes AGPL fournis par Signal](https://raw.githubusercontent.com/signalapp/libsignal/main/LICENSE)
doivent être respectés ; ce constat technique ne constitue pas une certification juridique.

Ne pas supprimer ou reconnecter le dépôt pour changer sa visibilité. Après autorisation de la
bascule, contrôler l'accès anonyme, les collaborateurs autorisés, la synchronisation Lovable,
les intégrations et un build de prévisualisation. En cas d'échec, arrêter la publication et
réparer l'accès existant ; ne pas rendre le dépôt public ni élargir des permissions sans accord.
Les [effets de visibilité GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
sur Pages, forks, étoiles, scanners et fonctionnalités privées dépendent de l'état et du forfait.

Après une future publication, vérifier le contenu réellement servi des deux anciennes URL,
pas seulement leur statut HTTP : le routeur SPA peut répondre 200 sans servir l'ancien fichier.
Vérifier également les ressources CSS/images, le manifeste et la mise à jour PWA. Un retour
arrière doit conserver l'exclusion des deux anciens fichiers ; ne pas republier la page de reset
pour restaurer un client précédent. Les archives restent récupérables dans le dépôt.

## Livraison contrôlée et retour arrière

1. Conserver un artefact du client précédent et son identifiant de version. Relire la séquence
   des migrations du lot sécurité précédent ; ne pas appliquer en bloc les changements en attente.
2. Vérifier dans le projet **Lovable Cloud** les fonctions de feed et préférences déjà utilisées,
   leurs colonnes, les droits RLS et `check_rate_limit` sécurisé. La dépendance de quota est notamment
   décrite dans `20261018205651_harden_distributed_rate_limit_authority.sql`, du lot précédent.
   Appliquer ensuite la migration additive `20261026170313_feed_api_active_session_authority.sql`
   et vérifier ses droits, la présence des colonnes Auth attendues, puis le résultat sous le JWT
   d'un compte de test. Ne jamais appliquer le lot de migrations en attente sans revue séparée.
3. Livrer `feed-api` avec ses modules partagés seulement après cette vérification. `verify_jwt=false` est volontaire pour
   les pages publiques ; le handler valide lui-même toute session et toute opération privée.
4. Tester l'API servie : visiteur public, token invalide, compte A/B, préférences, quotas,
   origine ForSure, prévisualisation, curseur étranger/expiré, pages avec compte bloqué.
   Avec un compte de test consentant : conserver son token en mémoire uniquement, révoquer sa
   session par la déconnexion normale, puis vérifier que le même token n'obtient plus de contenu
   ou d'écriture via `feed-api`. Aucun token ne doit être inclus dans un rapport ou une capture.
   Ne jamais publier le nouveau client avant ces contrôles.
5. Publier le client compatible après autorisation, puis vérifier `version.json`, les bundles
   réellement servis, le feed, ses préférences, actualités, photos/vidéos et le renouvellement PWA.
   Contrôler aussi connexion, appareils, texte/vocal/appels sur deux comptes de test consentants.
6. Si le nouveau parcours régresse : revenir au client précédent compatible, laisser l'API
   additive disponible pour les clients déjà chargés et diagnostiquer. Ne pas assouplir RLS,
   les quotas ou l'approbation d'appareil, et ne pas effacer le navigateur ou les clés.
   Pour un incident du contrôle de session, conserver la migration et le refus sûr (503 si état
   inconnu), puis réparer la disponibilité ; ne pas retirer la vérification ou réintroduire un
   ancien endpoint permissif comme retour arrière de sécurité. Avant toute publication, garder
   les artefacts précédents et tester le parcours de retour sur l'environnement pilote.

## Références officielles consultées

- [Sécurisation des fonctions Edge](https://supabase.com/docs/guides/functions/auth) : JWT et clients
  limités à la session du lecteur ; terminologie SDK, hébergement du projet maintenu dans Lovable Cloud.
- [Sessions Auth](https://supabase.com/docs/guides/auth/sessions) : présence du `session_id` dans
  le JWT et vérification dans `auth.sessions` pour tenir compte d'une déconnexion avant son expiration.
- [OWASP API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/) : autorisation,
  exposition de propriétés et maîtrise des ressources.
- [Lovable — paramètres du projet](https://docs.lovable.dev/features/projects/settings) : masquage officiel du badge.
- [Lovable — domaines](https://docs.lovable.dev/features/custom-domain) : identité de domaine distincte
  de la confidentialité du code exécuté dans un navigateur.
