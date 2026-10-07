# Architecture du feed et exploitation

> Mise à jour du 7 octobre 2026 : l'adaptateur IPinfo **de découverte/publicité**
> décrit dans l'historique ci-dessous est remplacé par DB-IP City Lite gratuit,
> sans appel à une API IP tierce. Voir [le guide d'intégration DB-IP](../../scripts/geoip/README.md)
> pour les dix langues, l'attribution, les prérequis Lovable Cloud, les quotas,
> les tests et le retour arrière. Code préparé localement, pas activé dans le Cloud.
> L'adaptateur de sécurité de connexion et Aegis/Libsignal restent inchangés.

Le feed ForSure sépare la diffusion synchrone, la collecte de signaux et les traitements différés. Le classement utilise les données déjà calculées ; aucune requête vers un modèle génératif ne se trouve sur le chemin de lecture du feed. L'hébergement reste Lovable Cloud. Les dossiers `supabase` décrivent son infrastructure existante, pas un nouveau projet indépendant.

Cette évolution ne modifie pas Aegis, Libsignal ou les coefficients du classement actif. Elle change les contrôles d'accès, la fiabilité des données et la constitution des pages. Les modèles candidats restent hors production.

## Diffusion et pagination

`get_ranked_feed_page` déduit le lecteur de sa session et appelle la récupération multi-source, le filtre de confidentialité puis le classement par lots de 200 candidats, jusqu'à 500 candidats. Un instantané conserve jusqu'à 200 résultats pendant 30 minutes. La première page et les suivantes lisent le même ordre après application des préférences et de la diversité.

Un curseur appartient au lecteur et à l'instantané. Chaque lecture revérifie visibilité du profil, visibilité de la publication, blocages, expiration et préférences. Le client propose un rafraîchissement explicite à expiration, sans mélanger deux classements. Le plafond auteur est appliqué sur une fenêtre glissante de 12 publications ; si la réserve manque d'auteurs différents, les publications restantes ne sont pas supprimées. Les modes chronologique et amis restent prioritaires sur cette diversification.

Les protections de contenu sensible existantes restent en place. Le score par défaut des publications non classifiées ne constitue toutefois pas une certification de sûreté. Une modération multimodale exhaustive et une politique dédiée aux contenus non évalués restent nécessaires avant de revendiquer cette garantie, notamment pour les mineurs.

## Signaux et expérience

Le serveur émet un `exposure_id` lié au lecteur, à la publication et à la version de l'expérience. `ml_ingest_feed_events` vérifie cette preuve, le consentement analytique, les types, la visibilité et un quota par utilisateur. Il impose les poids et écrit interaction et événement A/B dans la même transaction. Les insertions directes des clients ne sont plus autorisées.

Les files navigateur sont bornées, sérialisées et utilisent des identifiants stables pour les reprises. La durée d'exposition exclut l'arrière-plan. Une complétion vidéo exige de la lecture effective, sans compter les sauts dans la vidéo. Les métriques opérationnelles et le tableau de qualité restent séparés des événements d'apprentissage. Il s'agit de télémétrie au mieux : fermeture brutale ou panne prolongée peuvent encore perdre un lot ; elle ne sert pas de preuve de facturation.

Une preuve de diffusion ne prouve pas qu'un humain a réellement regardé le contenu. Les événements client restent manipulables par leur propre utilisateur. Quotas, déduplication, cohortes et contrôles antifraude restent indispensables à l'interprétation des expériences.

## Enrichissement et apprentissage

`feed_feature_jobs` gère le rattrapage et les nouvelles publications. Le traitement requiert consentement de partage IA, personnalisation et visibilité publique. La réservation atomique possède un délai de cinq minutes et une révision renouvelée à chaque reprise. Une modification du texte invalide l'ancien vecteur. La finalisation vérifie à nouveau révision, consentement et publication ; un ancien worker ne peut pas écraser une version récente. Les erreurs attendent avec délai croissant, jusqu'à huit tentatives. Un nouveau consentement réactive les tâches abandonnées.

Le traitement de caractéristiques limite les lots à 40 publications, les événements à 10 000 et le contexte à 2 000 publications. Les appels réseau ont des délais limites et le traitement vérifie un budget de 90 secondes entre lots. Le texte public partagé est réduit à 200 caractères, avec retrait de motifs courants de coordonnées ; ce retrait n'est pas une anonymisation garantie. Les publications sans texte suffisant restent explicitement sans embedding sémantique.

Les vecteurs sémantiques 768 dimensions ne sont pas repliés dans l'espace appris 256 dimensions. Le candidat Two-Tower est une factorisation expérimentale déterministe, pas un modèle neuronal de niveau industriel. Son évaluation utilise des paires utilisateur/publication disjointes ordonnées dans le temps. Les minima hors ligne sont 100 paires évaluées, 20 utilisateurs, 90 % de couverture et amélioration de l'erreur face à son initialisation. Ce dernier point ne prouve pas un gain face au classement de production.

Le candidat est enregistré en une écriture privée ; un candidat refusé ne conserve pas ses vecteurs. Aucune promotion automatique n'est possible. MMR reste une comparaison parallèle sans effet sur l'ordre reçu. Une validation contre le classement actuel, des indicateurs de classement et une expérience en ligne contrôlée sont requis avant toute promotion ou modèle multi-objectifs.

## Moteur Python ForSure

`ml/feed_ai` ajoute un moteur de recommandation entraîné depuis zéro avec Python 3.12 et NumPy 2.2.6. C'est une factorisation utilisateur/publication avec biais, pas un chatbot, un modèle de langage ou un filtre de modération. Il apprend ses propres paramètres, sans appel à un fournisseur génératif. Le candidat TypeScript existant reste séparé ; aucun des deux ne remplace automatiquement le classement actif.

Le moteur Python traite au maximum 10 000 événements, avec 32 dimensions et 20 époques par défaut, un seul thread de calcul natif et un budget d'entraînement de 60 secondes. Les paramètres exposés sont bornés à 128 dimensions et 50 époques. Les fichiers d'entrée et les lots réseau sont limités en taille. Les erreurs et dépassements arrêtent le travail sans publier de modèle ni modifier les tables de production.

La séparation utilise une date de coupure : aucun événement futur n'entre dans l'entraînement et une paire utilisateur/publication déjà apprise est exclue de l'évaluation. Les métriques incluent erreur quadratique, NDCG à 10, couverture et nouveaux utilisateurs/publications. Le comparateur est une affinité moyenne par publication lissée, calculée uniquement sur l'entraînement. Les cas inconnus conservent ce repli dans les métriques. Les métriques de classement utilisent les publications observées dans la période future, pas les listes complètes réellement servies : elles ne prouvent pas un gain causal face au feed en production.

Les modèles sont sauvegardés en JSON, avec empreinte du jeu de données et rapport reproductible. Le chargement vérifie format, dimensions, identifiants et valeurs finies ; il ne désérialise pas d'objets Python exécutables. Une prévisualisation locale accepte au maximum 200 publications déjà filtrées. Elle n'applique pas elle-même blocages, confidentialité ou modération et ne doit donc pas devenir une route publique.

### Utilisation locale

Depuis la racine du dépôt, PowerShell peut utiliser directement l'interpréteur isolé, sans changer la politique d'exécution Windows :

```powershell
python -m venv ml/.venv-feed
& .\ml\.venv-feed\Scripts\python.exe -m pip install --only-binary=:all: -r ml/requirements-feed.txt
& .\ml\.venv-feed\Scripts\python.exe -m unittest discover -s ml/tests -v
& .\ml\.venv-feed\Scripts\python.exe -m ml.feed_ai demo
```

La démonstration utilise exclusivement des préférences fictives. Son statut reste `synthetic_only`, quel que soit le score. Les sorties sont rangées sous `ml/runs/<nom>/candidate.json` et `report.json`, exclus de Git. Une nouvelle exécution refuse d'écraser un dossier existant. Le rapport termine l'écriture et sert de marqueur de complétion.

Pour travailler sur les données réelles, `train-cloud` appelle uniquement la RPC existante `feed_training_events` du projet Lovable Cloud. Les migrations de fiabilisation doivent être réellement appliquées avant cette utilisation. Configurer `LOVABLE_CLOUD_API_URL` et `LOVABLE_CLOUD_SERVICE_ROLE_KEY` dans l'environnement du processus serveur via le gestionnaire de secrets, jamais dans le frontend, un argument de commande ou un fichier suivi par Git, puis lancer :

```powershell
& .\ml\.venv-feed\Scripts\python.exe -m ml.feed_ai train-cloud --limit 5000
```

L'adaptateur effectue seulement des lectures HTTPS vers cette RPC, sans redirection, avec échéance par requête et budget total. Le serveur vérifie le consentement analytique et de personnalisation à chaque lecture. Seuls les identifiants d'événement, de lecteur, de publication, le type de signal et la date sont sélectionnés. Ni texte de publication, ni conversation, ni clé Aegis/Libsignal ne sont chargés. Les événements restent en mémoire ; le modèle conserve néanmoins des identifiants et préférences dérivées, donc des données personnelles à protéger. Les fichiers ignorés par Git ne sont pas chiffrés : conserver les sorties dans un espace administrateur avec les droits locaux appropriés.

Un export privé respectant le même contrat peut aussi être donné à `train --input <fichier>`. Un fichier local n'est pas une preuve de consentement actuelle. Un retrait de consentement ou une suppression de compte impose de retirer les exports/candidats concernés et de recalculer avant toute utilisation. Cette réconciliation et la purge automatique ne sont pas encore intégrées ; les modèles restent hors production. La pagination utilise une date fixe mais n'est pas un instantané transactionnel entre requêtes : un retrait de consentement pendant l'export peut réduire l'échantillon.

`preview --model <candidate.json> --user-id <uuid> --posts <uuid> <uuid>` recharge un candidat et montre son ordre local sans écrire sur le serveur. Aucun appel Python n'est ajouté à l'ouverture du feed. Aucun service Python permanent ni hébergement supplémentaire n'est provisionné. Le workflow CI exécute les tests et la démonstration fictive sans secret de production ni publication d'artefacts personnels.

La mention `offline_candidate` requiert au moins 100 paires futures, 20 lecteurs évaluables, 90 % de couverture, amélioration NDCG face au comparateur et erreur non dégradée. Elle reste un filtre exploratoire, pas une validation statistique ou une permission de déployer. `promotion_allowed` reste toujours faux. Il faut ensuite comparer aux listes et scores réellement servis, vérifier les cohortes et consentements, puis autoriser explicitement une expérience limitée avec retour au classement actuel.

Les commandes reposent sur l'[environnement virtuel Python](https://docs.python.org/3/library/venv.html), les [générateurs NumPy](https://numpy.org/doc/2.2/reference/random/generator.html) et l'[interface RPC PostgREST](https://docs.postgrest.org/en/stable/references/api/functions.html) de l'infrastructure existante de Lovable Cloud.

### Comparaison avec les listes réellement servies

La migration `20261005211535_feed_offline_evaluation_contract.sql` conserve le mode du feed et le plafond auteur dans l'instantané existant, avec sa révision d'expérience. Elle laisse le classement et ses coefficients inchangés. La RPC privée `feed_evaluation_slates` exporte seulement les publications effectivement servies, dans leur ordre d'origine, avec les signaux vérifiés reçus pendant les cinq minutes suivant chaque exposition. Une liste trop récente attend ; une absence de retour reste inconnue, pas négative.

La lecture exige le consentement analytique et de personnalisation du lecteur. Elle revérifie visibilité publique, consentement IA du créateur, expiration et blocages. Si une publication exposée n'est plus admissible, la liste entière est exclue, afin de ne pas fabriquer une nouvelle référence. Les exports sont limités à 50 listes de 200 publications, sans texte, conversation ou clé cryptographique. L'accès est réservé au rôle serveur ; les clients anonymes et authentifiés n'ont aucun droit d'exécution.

Les instantanés expirent toujours après 30 minutes : exporter des listes matures avant leur expiration est nécessaire. Aucun historique supplémentaire n'est créé et les anciennes listes sans contexte ne sont pas reconstruites. Le nombre de listes disponibles peut donc être faible, notamment après retrait de consentement. Les exports réels restent des données personnelles, soumis aux protections et obligations de purge décrites plus haut.

Le candidat compare ses scores vectorisés à l'ordre enregistré, avec un mélange fixé à 25 % modèle et 75 % rang initial pour cette expérience hors ligne. Les modes explicites tels que chronologique ne changent pas. Un utilisateur inconnu, une couverture inférieure à 90 % ou une erreur de calcul conserve l'ordre initial ; les publications inconnues restent à leur place. La fenêtre auteur reprend le plafond enregistré. Le candidat ne lit jamais les résultats observés pour choisir son ordre et n'ajoute ni ne retire de publication. Cette comparaison porte sur le reclassement d'un ensemble déjà servi, pas sur la découverte de nouvelles publications.

L'évaluation refuse un modèle entraîné sur des événements postérieurs ou égaux à la création d'une liste. Les cohortes de révision et variante ne sont pas mélangées. Le rapport contient NDCG sur les éléments observés, couverture, retours négatifs dans les dix premiers résultats, diversité des créateurs et latence locale de calcul. Il enregistre aussi les empreintes du modèle et des listes ainsi que les paramètres du candidat. L'intervalle de confiance rééchantillonne les lecteurs, non leurs impressions corrélées. Un examen favorable exige au moins 30 listes, 20 lecteurs évaluables, 90 % de couverture des retours au total et dans les dix premiers résultats des deux classements, un gain NDCG dont la borne basse dépasse zéro, sans hausse des retours négatifs ni baisse de diversité. Mettre en tête des publications sans retours ne peut ainsi simuler une amélioration des retours négatifs.

Les retours dépendent de la position où le contenu a été montré : ce rejeu ne corrige pas ce [biais de position](https://arxiv.org/abs/1608.04468) et ne prouve pas un gain causal en ligne. Même `ready_for_review` n'autorise aucune promotion ; `promotion_allowed` reste faux. Une expérience en ligne limitée, autorisée et réversible reste indispensable.

```powershell
# 40 lecteurs fictifs, 200 publications par liste, aucun appel réseau.
& .\ml\.venv-feed\Scripts\python.exe -m ml.feed_ai benchmark --name validation-replay

# Modèle entraîné avant les listes à évaluer ; exports privés au contrat strict.
& .\ml\.venv-feed\Scripts\python.exe -m ml.feed_ai evaluate --model ml/runs/entrainement/candidate.json --evaluation listes-privees.json

# Même API Lovable Cloud et secrets serveur que train-cloud, lecture seule.
& .\ml\.venv-feed\Scripts\python.exe -m ml.feed_ai evaluate-cloud --model ml/runs/entrainement/candidate.json
```

Le rapport est enregistré seul dans `ml/runs/<nom>/report.json` ; le benchmark conserve aussi son modèle fictif dans `<nom>-model`. Utiliser un nouveau nom à chaque exécution. Le modèle d'une comparaison réelle doit précéder les nouvelles expositions : entraîner, laisser de nouvelles listes être servies, puis les exporter après la fenêtre d'observation. Aucun secret ni export réel ne passe par la CI.

Le benchmark local du 5 octobre 2026 a mesuré environ 0,33 ms au p95 pour le reclassement à chaud de 200 publications sur 40 listes fictives. Il a aussi détecté une baisse moyenne de diversité des créateurs de 0,1175 dans les dix premiers résultats : son filtre exploratoire refuse donc le candidat, malgré un gain de pertinence sur ces données. Ces nombres ne mesurent ni le réseau, ni Lovable Cloud, ni l'affichage des médias. Ils ne constituent pas une preuve d'amélioration du feed réel.

Le retour arrière de cette expérience consiste à arrêter les commandes d'évaluation et à écarter le candidat : aucun modèle Python n'est chargé par le feed. Le plafonnement des ressources et les tests sont reproduits dans la CI. L'accès serveur Lovable, l'application de la migration sur le vrai schéma et les mesures sur des données consenties restent nécessaires avant une expérimentation réelle.

## Publicités consenties et médias partenaires

La migration `20261005213316_consented_ads_and_local_media.sql` sépare trois consentements publicitaires : intérêts déclarés et tranche d'âge, activité publique, zone choisie. Aucun n'est activé par défaut, ni déduit de l'acceptation des CGU ou de la personnalisation du feed. Un compte sans âge adulte connu, ou marqué mineur, ne reçoit aucune publicité de ce circuit. Ce contrôle repose sur la date de naissance enregistrée et le contrôle parental ; il ne constitue pas une vérification documentaire d'âge.

La taxonomie fermée contient huit thèmes non sensibles. Le classement publicitaire utilise uniquement l'intersection de ces thèmes, puis la rotation des impressions. Les campagnes ciblant une catégorie inconnue, la santé ou le genre ne sont pas distribuées : les anciennes campagnes concernées doivent être adaptées, pas converties silencieusement. La borne 65 du formulaire signifie 65 ans et plus. Sans choix publicitaire, seuls les placements généraux adultes sont éligibles ; une campagne nationale française utilise le contexte français du service, pas une IP supposée.

L'analyse facultative lit au plus 30 publications propres, 50 commentaires propres sur des publications publiques et 100 événements de complétion vidéo attribués au feed. La fenêtre est limitée aux 30 derniers jours et commence au dernier accord. Seules les légendes des vidéos sont analysées, pas les images, l'audio ou les messages privés. Les réglages analytiques et de partage IA restent requis. Les comptes privés et textes avec marqueurs sensibles ou négatifs sont exclus. Deux signaux sont nécessaires pour retenir un thème.

Ce classificateur par mots-clés est une base déterministe et testable, pas une compréhension sémantique universelle : négation, ironie, langues et contexte implicite peuvent lui échapper. Il ne doit pas être présenté comme détectant toutes les informations sensibles. Une évaluation éditoriale multilingue et juridique précède toute extension de la taxonomie ou utilisation d'un modèle génératif. Le [DSA](https://eur-lex.europa.eu/eli/reg/2022/2065) interdit notamment le profilage publicitaire fondé sur les catégories sensibles et les publicités fondées sur le profilage des mineurs connus. Le [consentement décrit par la CNIL](https://www.cnil.fr/les-bases-legales/consentement) doit rester spécifique et retirable.

Les thèmes dérivés sont privés, utilisables cinq minutes, invalidés lors du retrait d'accord ou des changements de visibilité/contenu et supprimés par la tâche de nettoyage toutes les 15 minutes. Des références privées aux auteurs sources permettent l'invalidation ; elles disparaissent avec le cache. La diffusion et le comptage partagent la même règle d'éligibilité. L'export gratuit inclut ces préférences et thèmes pour le seul utilisateur authentifié. Les annonceurs ne peuvent lire ni ce cache, ni les préférences individuelles. Un nouveau calcul reste indépendant de la requête de classement social et ne modifie pas ses poids.

Les médias nationaux ne demandent aucune localisation. Les médias locaux utilisent pays, région et ville saisis ou confirmés dans les paramètres. Une détection facultative appelle [IPinfo Core](https://ipinfo.io/developers/core-api), avec un contrat et un jeton adaptés, puis demande confirmation. L'IP, les coordonnées et les journaux d'authentification ne sont pas conservés dans ces préférences. La localisation peut rester inconnue, notamment avec un VPN : la saisie manuelle est toujours disponible.

Le mode IPinfo de `local-media-location` exige un jeton utilisateur validé, une action volontaire et une limite persistante de cinq demandes par heure. Il ne reçoit pas une IP arbitraire du client. `LOCAL_MEDIA_TRUSTED_IP_HEADER` doit désigner un en-tête réellement écrasé par le gateway Lovable, vérifié en préproduction ; sans configuration, aucune détection IPinfo n'a lieu. Le jeton serveur `LOCAL_MEDIA_IPINFO_TOKEN` n'est jamais fourni au navigateur. Ce mode volontaire est distinct du contexte régional de passerelle décrit plus bas. Aucun achat ni activation du fournisseur n'est effectué par le code livré.

### Droits et import des médias

`media_partners` conserve une référence d'accord privée, le domaine autorisé, les droits d'extrait et de lecteur YouTube, une date de fin et la zone couverte. Aucun partenaire réel n'est préenregistré : les noms, flux et périmètres des accords restent à fournir. La zone est actuellement définie par partenaire ; un média couvrant plusieurs zones nécessite un adaptateur ou des éditions distinctes avant intégration. Les contenus complets et fichiers vidéo ne sont ni aspirés ni réhébergés.

### Import RSS quotidien (préparé, activation séparée)

La migration `20261005221140_daily_partner_rss.sql` et la fonction `partner-rss-sync` ajoutent un job dans le backend Lovable Cloud existant. La migration suivante `20261005223753_regional_media_discovery.sql` porte le réveil de la file à chaque heure (minute 7 UTC), pour traiter plus de 20 éditions sans un énorme lot. Chaque flux garde son échéance d'environ une journée (23 h minimum entre imports) ; une file vide ne déclenche pas de fonction réseau. Capacité théorique maximale : 480 prises de source/jour, à surveiller avant d'élargir davantage. Le job ne dépend pas d'un navigateur ou du PC du propriétaire. Le résultat SQL `DISPATCHED` confirme seulement la mise en file HTTP : vérifier aussi les logs Edge et `partner_rss_sources.last_status/last_success_at/last_error`, pas seulement le statut du cron.

Activation : appliquer d'abord les migrations discovery, RSS, puis regional_media_discovery, déployer `partner-rss-sync` avec son `deno.json` et `local-media-location`, enregistrer le même secret aléatoire d'au moins 32 caractères dans le coffre du backend (`partner_rss_cron_secret`) et les secrets de fonction (`PARTNER_RSS_CRON_SECRET`), puis définir `PARTNER_RSS_ENABLED=true`. Ne jamais utiliser une clé service-role comme secret cron. Aucune de ces opérations de production n'est réalisée par les tests ou l'ajout du code.

Chaque flux doit référencer un `media_partners` actif avec un accord réel non expiré et un domaine exact. Ajouter alors sa clé de catalogue à `partner_rss_sources`, initialement `enabled=false, auto_publish=false`. Activer `enabled` après vérification du flux et des droits. Le premier lot de 29 flux régionaux et nationaux a été élargi à 44 flux accessibles, détaillés ci-dessous : 34 récents au contrôle du 6 octobre 2026 (heure de Paris), couvrant les 18 régions. Les flux sans entrée récente restent visibles comme lacunes de fraîcheur, sans importer d'anciens articles comme nouveautés. L'Union/L'Ardennais n'a pas encore d'URL confirmée et reste bloqué. Ce catalogue n'est pas un recensement exhaustif de tous les titres français. La découverte d'un flux ne vaut jamais autorisation de republication.

Une édition régionale exige un partenaire `country='FR'`, `region` correspondant au nom officiel du catalogue (accents et séparateurs tolérés), `city=NULL` sauf édition municipale (Marseille). Créer un partenaire distinct pour chaque édition géographique, même en présence d'un contrat commun : ne pas associer les 17 régions à un partenaire national. Le worker refuse une incohérence avec `SOURCE_COVERAGE_MISMATCH` avant tout appel réseau. L'échelle d'une édition reste affichée : un flux régional n'est pas présenté comme concernant précisément la ville du lecteur.

Inventaire reproductible sans secrets ni écriture : `node scripts/verify-regional-rss.mjs` (catalogue), ou `node scripts/verify-regional-rss.mjs --live` (trois lectures publiques simultanées au maximum, métadonnées uniquement). Les compteurs distinguent présence dans le catalogue et fraîcheur réelle. `get_partner_rss_coverage()` est réservé au service serveur et mesure les sources configurées/autorisées/en échec/en attente, la dernière réussite et le nombre d'articles visibles par région. Une région absente du résultat n'a aucun flux configuré ; ne pas confondre couverture du catalogue et couverture réellement déployée.

### Choix local sans profilage implicite

La zone enregistrée volontairement reste prioritaire. Le bouton « Utiliser la ville de mon profil » lit uniquement la ville du compte authentifié via `get_my_media_profile_city()` (aucun identifiant fourni par le navigateur), puis propose les communes de l'[API administrative officielle](https://geo.api.gouv.fr/decoupage-administratif/communes). La recherche se fait à la demande, via le backend : nom ou code postal, sans autres données de profil, IP du navigateur ou coordonnées. Les résultats affichent la région et le département ; aucun résultat n'est sélectionné ni enregistré automatiquement. La zone enregistrée reste ville/région/pays, pas une position GPS ni un domicile vérifié.

La recherche volontaire IPinfo conserve son action explicite et son quota de cinq appels par heure ; commune et contexte ont un quota séparé de 30 appels/minute. Le fournisseur IPinfo et l'en-tête de passerelle fiable doivent être configurés sur Lovable Cloud avant activation (`LOCAL_MEDIA_IPINFO_TOKEN`, `LOCAL_MEDIA_TRUSTED_IP_HEADER`). Sans cela, la saisie manuelle et le profil restent utilisables. Les codes IP des cinq DROM sont rattachés aux régions françaises correspondantes. Une IP signalée VPN/relais par IPinfo n'est pas utilisée. Une réponse tardive ne remplace pas les choix d'un autre compte.

Le feed commence par charger ses actualités sans attendre la localisation. La sélection contextuelle décrite ci-dessous peut ensuite proposer une zone en arrière-plan. « Près de moi » priorise ville puis région puis sources nationales autorisées. Aucun article d'une autre région n'est maquillé en actualité locale. Déduplication par URL, quatre cartes maximum par domaine éditeur et douze au total. Les réglages publicitaires ne sont pas activés par ce choix ; blocages éditoriaux, droits expirés et restrictions mineurs restent appliqués. Le panneau reste facultatif et non bloquant pour le feed, Aegis et Libsignal.

### Extension nationale et discussions — 6 octobre 2026

Le contrôle public à `2026-10-05T23:03:13Z` trouve **44 flux accessibles**, dont **34 avec des entrées de moins de sept jours**, couvrant les **18 régions**. Huit autres titres sont recensés sans destination activable. Il ne s'agit ni de tous les journaux français, ni de 44 rédactions distinctes : certaines lignes sont des éditions du même réseau. Le Monde, Le Figaro, Libération, L'Humanité, Ouest-France, La Dépêche, Midi Libre, L'Indépendant, L'Est Républicain, le Républicain Lorrain et Nice-Matin font partie des ajouts récents. Les flux généraux testés du Bien Public, du JSL, des DNA et de L'Alsace sont accessibles mais anciens ; ne pas présenter leurs articles comme nouveaux.

Les [conditions RSS du Monde](https://www.lemonde.fr/le-monde-et-vous/article/2025/07/14/les-flux-rss-du-monde-fr_5498778_3237.html) réservent le flux à un usage personnel et demandent une autorisation pour les autres usages. L'inscription au catalogue ne crée aucun accord ni activation. Les droits du partenaire doivent être renseignés avant ingestion ; aucun contenu complet, paywall ou photo n'est recopié.

La migration `20261005225507_news_discussions_and_context.sql`, après les trois migrations discovery/RSS/régionales, relie chaque URL d'article modéré à un fil ForSure durable. Les liens `/news/:id` permettent commentaires, réponses à un niveau, partage sur le fil et via la messagerie existante, copie ou partage système. Les commentaires ne sont pas publiés au nom du journal. La pagination est de 50 contributions avec curseur temporel + UUID, ordre stable et sentinelle ; rafraîchissement toutes les 30 secondes au premier plan. Les métadonnées sous licence ne sont renvoyées que tant que le contenu est autorisé et modéré. Leur expiration laisse un titre générique et le lien source, sans effacer les échanges.

Écritures exclusivement via RPC authentifiées, auteur pris dans `auth.uid()`, corps limité à 1 000 caractères rendus en texte, délai serveur atomique de trois secondes, UUID d'idempotence conservé après erreur réseau, parent dans le même fil, blocages bidirectionnels, suppression de son propre texte et refus des discussions fermées. Un mineur ne peut consulter qu'une actualité encore active et marquée adaptée. La suppression du compte efface aussi le texte de ses contributions, tout en gardant les réponses. Le signalement est dédupliqué, limité à 20 par heure et envoyé à la file administrateur existante ; celle-ci permet de voir le contexte et masquer le commentaire avec contrôle du rôle serveur. L'export gratuit ajoute les 1 000 dernières contributions propres avec total et indicateur explicite de troncature ; un export dépassant cette borne nécessite une extraction opérateur complémentaire. Pas de branchement des commentaires d'actualité au profilage publicitaire.

### Sélection contextuelle sans fenêtre GPS

Validation finale locale de cette extension : **212 fichiers Vitest, 1 175 tests réussis, trois ignorés**, **269 vérifications SQL fonctionnelles** (78 discovery, 39 RSS, 39 régional, 53 discussions, 60 feed). Build production, types application/Node/Edge, échanges réels WASM Libsignal et contrôle de frontière navigateur réussis. Les vérifications React ont conduit au chargement des conversations privées seulement à l'ouverture du partage ; les règles de base ont guidé les RPC privées, l'auteur serveur, les limites atomiques et la séparation entre contexte éditorial et publicité. Ces résultats ne constituent pas un test utilisateur en production ni une mesure de latence sur Lovable Cloud.

La demande utilisateur porte sur une sélection approximative automatique, pas une autorisation d'activer la publicité. `LOCAL_MEDIA_CONTEXT_ENABLED=true` active le contexte côté Lovable, après documentation du but, de la base juridique et des informations utilisateur. Le [cadre CNIL sur l'intérêt légitime](https://www.cnil.fr/fr/les-bases-legales/interet-legitime) requiert une mise en balance ; l'absence de fenêtre GPS ne vaut pas conformité juridique générale. Le code reste désactivé tant que ce paramètre n'est pas configuré.

Priorités : choix enregistré > commune non ambiguë du profil > région réseau fiable > sélection France. Le retrait enregistré (`local_media=false`) arrête les inférences et prévaut aussi dans la RPC, même si le navigateur fournit une autre zone. Les choix publicitaires restent inchangés. Aucun emplacement automatique n'est persisté : le cache React est propre au compte, valable dix minutes, sans attente imposée au feed. La consultation du répertoire des communes transmet seulement la ville recherchée au service public, jamais l'IP du membre ou son identifiant.

Configurer `LOCAL_MEDIA_TRUSTED_GEO_COUNTRY_HEADER` et `LOCAL_MEDIA_TRUSTED_GEO_REGION_HEADER` **uniquement après vérification que la passerelle les écrase**, avec région française ISO (`GES`, `FR-GES`, etc.) ou code INSEE. Sans métadonnée fiable, aucune ville ou région n'est inventée ; GPS et recherche IPinfo ne sont jamais appelés automatiquement. Le bouton distinct IPinfo reste une action volontaire documentant ce transfert tiers. Le contexte réseau sert seulement à filtrer des actualités publiques : jamais à approuver un appareil, vérifier une identité ou cibler une publicité. VPN/relais/réseaux mobiles peuvent indiquer la région du point de sortie ; l'interface l'annonce comme approximative et permet de la changer.

Déploiement : valider la migration sur le schéma Lovable complet, déployer `local-media-location` et `data-export`, puis le frontend ; confirmer les droits et les sources séparément. Tester deux comptes, un compte mineur, un blocage, perte de connexion après enregistrement, réponses, signalement et modération, suppression de compte, expiration RSS et retrait du choix local. Vérifier aussi les liens partagés sur mobile. Retour arrière : désactiver `LOCAL_MEDIA_CONTEXT_ENABLED`, arrêter les sources concernées et restaurer le frontend précédent ; conserver les tables/discussions, ne pas effacer les clés ou archives Aegis/Libsignal. Cette livraison locale n'a activé aucun fournisseur, accord, donnée utilisateur ni tâche Cloud.

Validation locale du lot régional : 209 fichiers de tests, 1 152 tests réussis et trois ignorés ; 78 contrôles discovery, 39 RSS, 39 routage régional et 60 feed sur PostgreSQL isolé. Typecheck application/Edge, build production, échanges réels WASM Libsignal et frontière navigateur réussis. Les contrôles React ont conservé les appels externes à la demande, les choix explicites et l'isolation lors d'un changement de compte. Un changement serveur des droits ou de la zone d'une édition invalide aussi son bail d'import en cours. Aucun déploiement, accord, consentement, import ni publication en production n'a été effectué par ces vérifications. Le parcours réel sur Lovable Cloud reste à valider après configuration.

Le flux général du Parisien testé ne fournit que `title` et `link`. Un adaptateur limité à son domaine extrait la date au jour depuis le suffixe éditorial `-JJ-MM-AAAA-IDENTIFIANT.php` et valide réellement la date calendaire. Ce n'est pas une heure de publication exacte. Aucune date n'est inventée pour les liens qui ne respectent pas ce format. Les autres sources utilisent la date déclarée dans RSS/Atom.

Le worker limite à 20 sources/run, trois requêtes parallèles, huit secondes et 1 Mo par flux décompressé, 500 entrées lues et 50 actualités récentes importées. Il n'accepte aucune URL dans la requête, aucun cookie ni redirection, DTD ou entité XML externe. RSS 2 et Atom UTF-8 sont pris en charge. Une entrée sans date valide, future, trop ancienne, sans titre ou hors domaine autorisé n'est pas publiée. Les réponses HTML/403 ne sont pas contournées. ETag/Last-Modified évitent les téléchargements identiques. Les identifiants dépendent de l'URL canonique sans paramètres de suivi : GUID changeants, redémarrages et import quotidien ne dupliquent pas la même actualité et ne rajeunissent pas sa date. La rétention est limitée à sept jours et à la durée de l'accord.

`auto_publish=true` est une décision explicite de confiance éditoriale, indépendante des droits contractuels : seules les nouvelles cartes texte du flux autorisé sont alors publiées automatiquement pour les adultes. Un article déjà rejeté n'est pas réapprouvé, un article modifié repasse en revue, et aucun contenu n'est classé automatiquement adapté aux mineurs (`family_safe=false`). Sans ce réglage, les imports restent en attente de revue. Ni photo, ni article intégral, ni fichier vidéo ne sont importés par ce lecteur RSS. Les extraits sont limités à 400 caractères et uniquement si `allow_excerpt=true`.

Retour arrière sans perte de messages : désactiver le job dans Cloud → Jobs ou mettre `PARTNER_RSS_ENABLED=false` ; désactiver une source avec `enabled=false` invalide son travail en cours. Désactiver `media_partners.active` retire immédiatement ses cartes du feed. Rien ne touche Aegis, Libsignal, les clés utilisateur ou les messages. Les tests `npm run test:discovery-db` comprennent les permissions, les baux exclusifs et expirés, l'idempotence, les droits expirés/révoqués et la publication sélective ; `src/test/partnerRss.test.ts` couvre parsing, réseau et authentification.

L'import réservé au serveur accepte 50 cartes au maximum et vérifie droits actifs, domaine HTTPS, durée de disponibilité, format et taille. Les nouveaux contenus et modifications retournent en attente de modération. Les mineurs et comptes d'âge inconnu ne voient que les cartes explicitement validées comme adaptées à tous. Le feed affiche titre, source, lien et extrait autorisé. Les lecteurs [YouTube en mode de confidentialité avancé](https://support.google.com/youtube/answer/171780?expand=PrivacyEnhancedMode&hl=en) attendent un clic ; ce mode n'est pas une absence de communication avec YouTube. La CSP ne permet que le domaine `www.youtube-nocookie.com` pour ces lecteurs.

Un adaptateur RSS/API propre à chaque partenaire devra produire un tableau JSON : `external_id`, `title`, `canonical_url`, `kind` (`article` ou `video`), `published_at`, `expires_at`, éventuellement `excerpt` et `youtube_id`. Aucun HTML exécutable n'est accepté. Exemple de commandes opérateur, sans secret en argument :

```powershell
# Validation locale uniquement, pas d'accès réseau ni de publication.
node scripts/import-partner-media.mjs PARTNER_UUID lot-medias.json
# Seulement après enregistrement des droits dans Lovable Cloud et validation du lot.
# FORSURE_CLOUD_SERVICE_ROLE_KEY provient du gestionnaire de secrets du processus serveur.
node scripts/import-partner-media.mjs PARTNER_UUID lot-medias.json --apply
```

L'import ne crée pas de contrat, ne modère pas automatiquement et ne publie pas directement le lot. La RPC est atomique et l'identifiant externe déduplique les imports identiques. Aucun secret de production ou accord réel ne doit être enregistré dans Git.

### Validation et activation

1. Exécuter `npm run test:discovery-db`, les tests Vitest et le build. Le test SQL exécute la migration réelle dans PostgreSQL isolé avec des tables amont minimales ; il ne remplace pas l'application sur une copie du schéma Lovable complet.
2. Appliquer les migrations de livraison publicitaire et de feed prérequises, puis cette migration en préproduction. Vérifier les plans avec un volume représentatif et les temps des RPC publicitaires séparément du classement social. Aucun objectif de latence en production n'est validé par les fixtures.
3. Vérifier la tâche `discovery-expiry-cleanup` et son dernier succès. Si `pg_cron` est absent, programmer `cleanup_discovery_data` toutes les 15 minutes avec le scheduler Lovable avant toute activation : la politique de rétention affichée en dépend.
4. Déployer `local-media-location` et la mise à jour `data-export` via Lovable Cloud, puis le frontend. La saisie manuelle fonctionne sans fournisseur IP. Tester explicitement jeton expiré, en-tête IP forgé, fournisseur indisponible, refus/retrait d'accord, deux comptes et un compte mineur.
5. Enregistrer un partenaire seulement après vérification de son accord et de son flux, importer un petit lot, modérer, puis tester ville/région/France, expiration et lecture vidéo sur Safari iOS. Tester aussi les en-têtes CSP réellement servis, qui peuvent être plus stricts que la balise HTML.

En incident, désactiver les partenaires et retirer les injections locales du frontend ; conserver leurs tables et accords. Pour arrêter la personnalisation publicitaire, un opérateur peut remettre les consentements publicitaires (y compris `ads_location_auto`) à faux, effacer les caches dérivés et laisser seulement la diffusion générale adulte. Ne pas restaurer une ancienne fonction ignorant le consentement ni les anciennes permissions des métriques. Aucune clé ou archive Aegis/Libsignal n'est concernée par ce retour arrière.

### Publicités par ville : consentement et contexte de session

La migration `20261005231753_consented_city_ad_delivery.sql` rend `ads_location` indépendant de `local_media`. Une zone choisie peut servir à l'un ou l'autre usage, uniquement lorsque son réglage est actif. Les champs sont effacés quand les deux usages sont désactivés. Un **nouveau choix distinct** `ads_location_auto=false` par défaut autorise la détection publicitaire ; les anciens consentements ne sont pas étendus silencusement. Les mineurs connus, contrôles parentaux mineurs et âges inconnus restent exclus côté serveur.

Priorité publicitaire : zone choisie (même partielle) > commune non ambiguë du profil > zone réseau fiable > campagnes générales. La ville du profil est une déclaration, pas la position physique actuelle. La résolution réseau est approximative et les relais/VPN connus sont rejetés par l'adaptateur IPinfo. Le système n'invente pas de ville à partir d'une région. Une campagne par ville doit préciser sa région ; les accents, espaces et traits d'union sont normalisés. L'interface annonceur existante impose déjà de choisir une région avant les villes. Les campagnes locales éligibles passent avant les générales, sans changer les poids du feed ML. Les trois parcours `get_active_ads_for_placement`, `track_ad_interaction` et `get_my_ad_explanation` utilisent la même décision serveur.

La fonction `ad-location` vérifie le bearer avec `getUser`, puis lit le consentement adulte et le `session_id` via une RPC utilisant ce même JWT. Le corps doit être `{}` : aucune IP, ville, identité ou assertion de consentement n'est acceptée du navigateur. Seul le serveur peut écrire le cache. L'écriture verrouille les préférences et compare leur révision : une requête commencée avant un retrait, une nouvelle zone ou un changement de ville de profil ne peut pas restaurer l'ancien contexte. Les données sont privées (RLS, aucune lecture directe authentifiée ou annonceur), par utilisateur **et session**, valables 15 minutes, purgées toutes les 15 minutes par `cleanup_discovery_data`. Un résultat indisponible est aussi mis en cache pour éviter les appels répétés. Aucun historique, IP brute ni coordonnées n'y est enregistré. L'export personnel inclut ces seules zones et échéances ; la suppression du compte les cascade.

Le frontend lance la résolution indépendamment des créations publicitaires et du feed. Les caches React distinguent compte, session et révision sans conserver de jeton dans leur clé. Une panne ne suspend pas le fil ; les campagnes générales restent possibles, et les contrôles serveur refusent les interactions ciblées devenues inéligibles. Les informations « Pourquoi cette publicité ? » distinguent zone choisie, profil et estimation réseau.

Activation opérateur **dans Lovable Cloud**, après validation sur une copie du schéma complet :

1. Appliquer les migrations prérequises puis `20261005231753_consented_city_ad_delivery.sql`. Vérifier le nettoyage périodique avant d'activer la collecte.
2. Déployer `ad-location` et `data-export`, puis publier le frontend. Garder `ADS_LOCATION_AUTO_ENABLED=false` jusqu'aux contrôles de préproduction. La sélection manuelle ne dépend pas de ce drapeau.
3. Pour le réseau, configurer `ADS_LOCATION_TRUSTED_GEO_COUNTRY_HEADER`, `ADS_LOCATION_TRUSTED_GEO_REGION_HEADER` et facultativement `ADS_LOCATION_TRUSTED_GEO_CITY_HEADER` **seulement après preuve que la passerelle écrase/supprime toute valeur client**. Sans ville fiable, rester à la région. Aucun en-tête n'est implicitement fiable.
4. Alternative facultative : `ADS_LOCATION_TRUSTED_IP_HEADER` et secret `ADS_LOCATION_IPINFO_TOKEN`. L'IP n'est envoyée à IPinfo qu'après accord automatique explicite et validation serveur, et seulement si aucun contexte fiable n'est déjà disponible. Aucun appel externe ne lit les journaux de sécurité. Les limites sont 12 demandes/heure/compte, 900 ms/16 Ko pour IPinfo, 2 s/32 Ko pour le répertoire des communes ; aucune redirection ni URL fournie par le client.
5. Informer les membres, vérifier les mentions et le traitement fournisseur puis activer `ADS_LOCATION_AUTO_ENABLED=true`. Tester deux villes et deux sessions d'un même compte, refus/retrait, mineur, IP forgée, VPN, erreur fournisseur et cache expiré. Contrôler les temps et volumes réels : les tests isolés ne valident ni une ville IP réelle ni un p95 de production.

Retour arrière : désactiver le drapeau serveur et vider uniquement `ad_location_contexts` dans une opération opérateur autorisée ; cela supprime les estimations, pas les préférences manuelles. Sans purge, les estimations déjà valides expirent sous 15 minutes. Conserver les règles de consentement et les tables. Aucun changement cryptographique ni suppression de messages n'est requis.

Les tests SQL `scripts/test-ad-location-database.mjs` exécutent la migration réelle sur les fixtures PostgreSQL isolées. Les tests de fonction couvrent l'authentification, le refus de données client, le rate limit, les lieux ambigus, le cache et le retrait en cours. Les tests de hooks prouvent que les pubs générales s'affichent avant la résolution, qu'une erreur n'empêche pas l'affichage, et que les réponses ne traversent pas les comptes/sessions. Les réglages sont testés sans consentement implicite. Référence de conception : [CNIL, géolocalisation et applications mobiles](https://www.cnil.fr/fr/geolocalisation-applications-mobiles-quelles-regles) ; ce document technique ne vaut pas validation juridique des finalités de production.

### Configuration géographique vérifiée dans Lovable — 6 octobre 2026

Inspection de l'interface Cloud du projet existant, et requête de catalogue SQL en lecture seule : `local-media-location` et `ad-location` ne figurent pas parmi les fonctions déployées. Les cinq prérequis contrôlés (`discovery_preferences`, `ad_location_contexts`, `media_partners`, `get_my_ad_location_context`, `cleanup_discovery_data`) sont absents. La requête reproductible est `scripts/check-location-schema.sql` ; elle ne lit aucune ligne utilisateur. Les travaux locaux ne sont donc pas encore disponibles en production.

Seule modification Cloud de cette étape : création de `LOCAL_MEDIA_CONTEXT_ENABLED=false` et `ADS_LOCATION_AUTO_ENABLED=false`, vérifiée dans Secrets. Aucun schéma, compte, clé cryptographique ou déploiement existant n'a été modifié. Aucun jeton IPinfo ni en-tête de confiance n'a été configuré. Le modèle sans secret `supabase/location.env.example` précise les étapes suivantes : déployer et valider les prérequis, puis activer d'abord le profil/la commune officielle, et enfin le réseau si sa provenance et le fournisseur sont vérifiés. Ne pas publier en bloc les autres modifications locales pour activer ces deux interrupteurs.

Recherches et décision :

- Le [retour GitHub sur les IP des fonctions](https://github.com/orgs/supabase/discussions/7884) explique la disponibilité de `X-Forwarded-For`, mais un [autre rapport de reproduction](https://github.com/orgs/supabase/discussions/34647) montre qu'une valeur fournie par le client peut y être conservée. Ce rapport n'établit pas le comportement du gateway Lovable actuel. Il faut prouver l'écrasement ou la chaîne de proxies de confiance sur le point d'entrée réel avant activation ; jamais lire aveuglément la première IP.
- [Cloudflare Managed Transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/) peut ajouter pays, région et ville. Une configuration du domaine frontend ne prouve pas leur présence sur des appels directs au domaine des fonctions Lovable. N'utiliser que les champs grossiers ; aucune latitude/longitude, identification du domicile ou preuve d'identité.
- [IPinfo Lite et Legacy](https://support.ipinfo.io/hc/en-us/articles/34121895556242-Legacy-Free-API-vs-IPinfo-Lite) ont des contrats et réponses différents : Lite ne donne ni ville ni région. L'adaptateur présent attend [Core](https://ipinfo.io/developers/core-api), une offre premium. Aucun abonnement n'a été souscrit. Les sorties mobiles perdent le ciblage par ville, les réseaux anonymes/hébergement/satellite/anycast signalés sont rejetés, les régions françaises sont normalisées sur le catalogue officiel. Une région inconnue ne donne pas une ville utilisable.
- [GeoLite City](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data/) est une autre possibilité, avec compte/licence, attribution et rayon d'incertitude. Aucun compte ni téléchargement n'est activé ici. Multiplier les fournisseurs ne garantit pas une ville correcte et exposerait l'IP à davantage de destinataires : un seul fournisseur éventuel suffit.

Le pays, la langue, le fuseau horaire et le navigateur ne suffisent pas pour déduire une ville. Pas de requête GPS silencieuse. L'utilisateur conserve la correction manuelle, la séparation actualités/publicités et le retrait de la personnalisation ; pas de ciblage publicitaire personnalisé des mineurs. Les guides de sécurité du backend ont conduit à conserver la validation serveur et les interrupteurs désactivés jusqu'à la validation du schéma réel.

## Mesures et objectifs

Le panneau administrateur expose couverture, file de travaux, erreurs, résultats MMR, candidats et vues/clics A/B attribués au serveur. Les anciennes observations sans provenance ne valident pas une expérience.

`rpc_latency` mesure l'aller-retour du classement, `load_time` l'arrivée des publications côté React, et `media_ready` le chargement réel des médias prioritaires. Les FPS ne sont échantillonnés qu'au premier plan. La cible de 200 à 350 ms concerne le service du feed ; téléchargement vidéo, réseau mobile et temps de peinture sont des mesures distinctes. Elle doit être validée au p95 en charge, avec volumes et taux d'erreur précisés, à froid comme à chaud.

## Validation reproductible

- `npm run test:feed-db` exécute les migrations de diffusion et les fonctions de cycle de vie dans PostgreSQL isolé. Le classement amont est simulé et le type vecteur remplacé pour les tests de réservations : ce test ne valide ni les plans pgvector ni l'ensemble des migrations historiques.
- `npx vitest run --maxWorkers=1` vérifie les régressions applicatives avec mémoire bornée.
- `npm run build` vérifie aussi le vrai WASM Libsignal, les types et la frontière navigateur Aegis.
- Le workflow `feed-architecture.yml` reproduit ces contrôles sur les PR, ajoute le contrôle Deno des trois fonctions serveur et les tests Python avec démonstration et comparaison fictives.

## Livraison Lovable Cloud et retour arrière

1. Vérifier les migrations réellement présentes dans Lovable Cloud et la migration média `20260930182937_optimize_feed_media_delivery.sql`. Ne pas appliquer aveuglément les autres travaux locaux du dépôt. Sauvegarder les définitions des fonctions remplacées et identifier la dernière version frontend publiée.
2. Appliquer et tester les migrations `20261005202721_harden_feed_serving_and_events.sql`, `20261005203253_feed_training_lifecycle.sql` puis `20261005211535_feed_offline_evaluation_contract.sql` dans un environnement de validation possédant le vrai schéma et pgvector. Tester le premier chargement, les pages suivantes, deux comptes, un profil privé, un blocage, un retrait de consentement, un curseur expiré et l'export réservé au serveur.
3. Déployer les trois fonctions `ml-feed-train`, `ml-twotower-train`, `feed-optimizer`, puis publier le frontend. Le nouveau frontend dépend des nouvelles RPC et de `quality_events.client_event_id`. Un ancien client peut perdre de la télémétrie après révocation des insertions directes ; la lecture du feed ne dépend pas de leur succès.
4. Vérifier les horaires des tâches existantes, les secrets du gateway Lovable et les compteurs de file. Ne déclencher qu'un petit lot et contrôler coûts, erreurs et couverture. Vérifier séparément que les workers produisent des résultats réels avec le fournisseur configuré.
5. Mesurer les parcours mobile et ordinateur ainsi que les plans SQL sur des volumes représentatifs. N'activer aucun candidat avant comparaison hors ligne et expérimentation contrôlée.

En incident, suspendre les tâches d'apprentissage et restaurer la version frontend précédente. Conserver les nouvelles tables et les données : aucune suppression n'est nécessaire. Ne pas rétablir les anciennes permissions d'insertion ni retirer les filtres de confidentialité pour récupérer de la télémétrie. Si une fonction de classement doit être restaurée, reprendre sa définition sauvegardée dans une migration revue en conservant ces protections. `rollback_feed_legacy_config` ne restaure que l'ancienne configuration auxiliaire, avec détection de conflit ; il ne remplace pas ce retour arrière applicatif.

La validation locale n'autorise pas à déclarer un déploiement ou un objectif de latence atteint. La validation du schéma complet Lovable, le test en charge, la modération des contenus non évalués, la rétention des événements/candidats et le parcours mobile réel sont les derniers jalons d'exploitation à traiter avant qualification générale.
