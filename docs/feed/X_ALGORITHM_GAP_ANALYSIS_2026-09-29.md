# Audit du ML Feed ForSure face à l’algorithme « For You » de X

Date de l’audit : 29 septembre 2026.
Périmètre : lecture du code ForSure, contrôles agrégés de la base Lovable Cloud et comparaison avec le dépôt public [`xai-org/x-algorithm`](https://github.com/xai-org/x-algorithm).

Cet audit ne modifie ni le classement, ni les poids, ni les données du feed.

## Verdict

ForSure possède déjà de bonnes fondations : classement côté serveur, signaux positifs et négatifs, recherche vectorielle, index HNSW, expérimentation A/B, diversité d’auteur, exploration et protections de bien-être. Le premier besoin n’est pas d’importer un gros modèle de X. Il faut d’abord fiabiliser les briques déjà présentes : la télémétrie A/B est cassée, une partie des posts n’a pas d’embedding et les caractéristiques créateur ne sont pas alimentées.

## État vérifié en production

| Mesure | Valeur |
| --- | ---: |
| Posts | 58 |
| Interactions ML historiques | 5 979 |
| Interactions ML sur 7 jours | 758 |
| Embeddings de posts prêts | 40 |
| Posts sans embedding | 18 (31 %) |
| Embeddings utilisateurs prêts | 7 |
| Caractéristiques créateur | 0 |
| Événements A/B sur 7 jours | 0 |
| Expérience active | `recsys_v8_main`, répartition 50/50 |

L’expérience est donc active mais aveugle : elle ne reçoit aucun événement alors que des interactions sont bien enregistrées.

## Problèmes confirmés, par priorité

### P0 — La télémétrie A/B échoue à chaque appel authentifié

La fonction `ml_record_feed_ab_events` utilise `WITH ORDINALITY`, puis référence une colonne `ord` qui n’a jamais été nommée. PostgreSQL crée par défaut la colonne `ordinality`.

Le diagnostic exécuté contre Lovable Cloud reproduit exactement :

```text
ERROR: column "ord" does not exist
CONTEXT: PL/pgSQL function ml_record_feed_ab_events(jsonb)
```

Conséquence : impossible de savoir si la variante A ou B améliore le feed. Toute modification de poids avant réparation serait non mesurable.

Correction recommandée : aliaser explicitement la sortie, par exemple `jsonb_array_elements(p_events) WITH ORDINALITY AS events(value, ord)`, puis ajouter un test RPC authentifié qui vérifie l’insertion et la limite de 100 événements.

### P1 — La couverture vectorielle est incomplète

18 posts sur 58 n’ont pas d’embedding. Les files `ml_embedding_jobs` ne contiennent pourtant aucun travail en attente. Les candidats concernés ne peuvent pas profiter de la récupération sémantique.

Correction recommandée : réconcilier périodiquement les posts sans embedding, ajouter un compteur d’âge du plus vieux post non vectorisé et alerter lorsque la couverture descend sous 98 %.

### P1 — La branche « créateur » du modèle n’est pas alimentée

`ml_creator_features` contient zéro ligne. Les champs de fatigue et l’embedding créateur prévus par V8 retombent donc sur leurs valeurs neutres.

Correction recommandée : déclencher `ml_refresh_creator_features_v8` après les interactions importantes et avec un job de rattrapage, puis surveiller le taux de couverture.

### P1 — La pagination peut répéter ou sauter des posts

Le serveur reçoit un offset calculé à partir du nombre de posts restant **après** filtrage local des mots masqués et diversité. Si une page de 25 devient une page de 21 côté client, la page suivante repart à l’offset 21 au lieu de 25.

Correction recommandée : renvoyer un curseur serveur stable ou, au minimum, conserver séparément le nombre brut de lignes consommées. La diversité doit aussi être appliquée sur la frontière entre deux pages, pas indépendamment sur chaque page.

### P2 — Le mode invité et les droits de production ne sont pas alignés

Le client appelle `get_feed_posts_v8` puis `get_feed_posts` sans utilisateur, mais les fonctions de production ne sont pas exécutables par le rôle anonyme. Ce chemin ne peut fonctionner que si la page oblige déjà la connexion.

Décision recommandée : soit retirer clairement le faux mode invité, soit fournir un RPC public séparé, strictement chronologique, limité aux posts publics et sans données personnalisées.

### P2 — Préférences et trackers dupliqués

- La synchronisation serveur des préférences est lancée sans être attendue ; la première page peut donc utiliser un cache local périmé.
- `PostCard` instancie encore l’ancien `useMLTracking` devenu no-op en plus du tracker actif `useMLViewTracker`.
- Le commentaire « injecter de la découverte tous les cinq posts » n’a pas d’implémentation réelle dans `enforceDiversity`.

Ces points ne cassent pas le feed, mais compliquent son comportement et son diagnostic.

## Ce que X fait et qui est pertinent pour ForSure

Le dépôt de X décrit un pipeline explicite : hydratation de la requête, sources de candidats interrogées en parallèle, hydratation des candidats, filtres avant score, score, sélection, filtres de visibilité et effets secondaires. Les contenus suivis et recommandés sont récupérés séparément puis classés ensemble. X prédit plusieurs actions (engagement, clics, attention, suivi d’auteur et retours négatifs), puis combine leurs probabilités pondérées. La diversité finale est renforcée avec un reranker basé sur les embeddings. La visibilité reste séparée du classement. Source : [README officiel de X](https://github.com/xai-org/x-algorithm).

Les améliorations transposables, dans l’ordre :

1. **Rendre chaque étape observable et désactivable.** Mesurer latence, nombre de candidats, couverture, erreurs et fallback par source.
2. **Séparer les sources avec des quotas.** Réseau suivi, similarité sémantique, exploration/nouveaux auteurs et tendances locales ; fusionner puis dédupliquer.
3. **Mémoriser les impressions servies.** Éviter les répétitions entre pages et sessions courtes avant même le scoring.
4. **Diversifier par contenu, pas seulement par auteur.** Commencer par un reranking MMR simple sur les embeddings existants ; un DPP complet n’est pas nécessaire à cette échelle.
5. **Séparer strictement visibilité et rang.** Un post est d’abord autorisé, masqué derrière avertissement ou supprimé ; le score ne doit pas servir de substitut à une décision de sécurité.
6. **Évoluer vers plusieurs objectifs quand les données le permettront.** Prédire séparément clic utile, temps actif, interaction positive, masquage et signalement, puis publier clairement les poids utilisés.

## Ce qu’il ne faut pas copier maintenant

- Un transformer de classement de grande taille : 58 posts et 7 embeddings utilisateurs ne justifient pas cette complexité.
- L’infrastructure temps réel de X : elle répond à une échelle très différente.
- Des règles de modération opaques. Le dépôt de X précise que certains prompts et certaines règles anti-abus ne sont pas publiés pour limiter le contournement ; ForSure doit conserver des résultats explicables et un recours utilisateur.

## Plan sûr proposé

1. Réparer et tester la télémétrie A/B, sans changer les poids.
2. Remplir les embeddings et caractéristiques créateur manquants, avec métriques de couverture.
3. Corriger curseur, déduplication et diversité entre pages.
4. Exécuter une expérience limitée comparant le reranking actuel à un MMR sémantique.
5. N’envisager un modèle multi-objectifs qu’après obtention d’un volume de données fiable et d’indicateurs hors ligne/ligne cohérents.
