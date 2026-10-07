# Règles de maintenance Aegis

- Remplacer l'ancien chemin cryptographique au lieu d'empiler des formats ou des compatibilités.
- La Master Key utilise un seul format implicite courant, sans numéro de version applicatif.
- Toute modification cryptographique importante doit contenir un commentaire français court expliquant l'invariant corrigé.
- Une correction n'est terminée qu'après tests fonctionnels, typecheck et build.
- Ne jamais fusionner dans `main` sans ordre explicite de l'utilisateur.
- Edge Functions importent le code commun uniquement depuis `supabase/functions/_shared/`, jamais depuis le dossier d'une autre fonction : le déploiement Cloud n'emporte que la fonction ciblée et `_shared`.
