# Diagnostic zeus / content / improve — 2026-09-29 ~14:52 UTC

Diagnostic en lecture seule. Aucun changement de code n'est proposé.

## Ce qu'on a trouvé
- Journaux de la passerelle IA, 14:40–15:00 UTC : **aucune requête**. Aucune erreur (0) sur les 7 derniers jours. Les 16 requêtes de la semaine ont toutes réussi (HTTP 200, `google/gemini-3-flash-preview`) ; la plus récente date du 2026-09-27 à 22:20:54Z.
- Journaux de la fonction `zeus` : seulement `booted` à 14:52:55Z (2 instances) puis `shutdown` à 14:56:15Z. Aucune ligne `improve`, aucune erreur.
- Conclusion : la tentative de 14:52 a démarré la fonction, mais **aucun appel n'a atteint la passerelle**. Il n'y a donc ni statut HTTP ni corps d'erreur de la passerelle à rapporter. L'échec se produit dans `zeus` avant l'appel sortant : validation de l'action/du domaine, authentification, limite de débit ou chemin de retour anticipé. Cette hypothèse n'est pas confirmée, car la fonction ne journalise rien sur ces chemins.

## Identifiant du modèle
- Identifiant exact pour Gemini 3.1 Flash Lite sur `https://ai.gateway.lovable.dev/v1/chat/completions` : **`google/gemini-3.1-flash-lite`**. Il figure dans le catalogue disponible pour ce projet.
- L'appel doit rester côté serveur, dans la fonction edge, et jamais dans le code React/Vite du navigateur.

## Étape suivante possible (non exécutée)
Lire `supabase/functions/zeus/index.ts` pour trouver le chemin `content`/`improve` qui renvoie une réponse avant l'appel à la passerelle, puis ajouter une journalisation sûre du statut de retour.
