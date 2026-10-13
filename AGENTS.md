# Règles de maintenance Aegis

- Remplacer l'ancien chemin cryptographique au lieu d'empiler des formats ou des compatibilités.
- La Master Key utilise un seul format implicite courant, sans numéro de version applicatif.
- Toute modification cryptographique importante doit contenir un commentaire français court expliquant l'invariant corrigé.
- Une correction n'est terminée qu'après tests fonctionnels, typecheck et build.
- Pour tout diagnostic ou changement de messagerie, consulter la documentation officielle Signal/Libsignal et Sesame avant de modifier la logique. Distinguer l'enregistrement d'un appareil, son approbation et sa capacité de routage ; ne jamais recréer ses clés pour masquer une erreur de registre.
- Le backend de production est Lovable Cloud. Toute migration cryptographique doit vérifier la compatibilité avec le client réellement publié et les appareils existants avant activation ; conserver un retour arrière testé et ne pas déclarer un correctif validé sur les seuls tests simulés.
- Ne jamais fusionner dans `main` sans ordre explicite de l'utilisateur.
- Confirmation par e-mail : une erreur réseau ou une réponse perdue signifie « résultat inconnu dans ce navigateur », jamais « approbation refusée ». N'afficher un succès qu'après confirmation serveur ; conserver la liaison à la session d'origine. Les corrections d'affichage ne doivent changer ni les clés ni les règles d'approbation/routage.
- Afficher « Appareil approuvé » seulement après lecture serveur de l'appareil exact lié à la session cible, actif et non révoqué ; l'approbation de connexion seule ne suffit pas. Toujours informer l'utilisateur du succès confirmé.
- Edge Functions importent le code commun uniquement depuis `supabase/functions/_shared/`, jamais depuis le dossier d'une autre fonction : le déploiement Cloud n'emporte que la fonction ciblée et `_shared`.
- Post visibility rules must be enforced inside `public.feed_eligible_post_ids_internal`, not only in `posts` RLS: the ranked feed RPCs are SECURITY DEFINER and read `posts` while bypassing RLS.
