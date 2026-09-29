# Diagnostic ml-feed-train — embeddings (rien modifié)

## Constat (exécution 16:51 UTC)
- Log Edge `ml-feed-train` à 2026-09-29T16:54:17Z : `embedding HTTP error: 400`
  `{"type":"bad_request","title":"invalid model: google/text-embedding-004, allowed models: [...]"}` (request_id `01a0ee13d2e67c8ebab9678c07f8e029`), puis `shutdown` à 16:54:32Z.
- Pas de timeout : le modèle est refusé par la passerelle.

## Modèle accepté pour vector(768)
- `google/gemini-embedding-2` avec `"dimensions": 768` : HTTP 200, vecteurs de 768.
- Sans `dimensions`, il renvoie 3072 : le paramètre est donc obligatoire.
- Autres modèles d'embedding autorisés : `google/gemini-embedding-001`, `openai/text-embedding-3-small`, `openai/text-embedding-3-large`.

## Envoi groupé
- `input: ["a","b"]` : HTTP 200, 2 vecteurs de 768. L'envoi groupé est accepté.

## Correctif proposé (seulement après ton accord)
- Dans `supabase/functions/ml-feed-train/index.ts` : `model: "google/gemini-embedding-2"`, ajouter `dimensions: 768`, et mettre à jour `embedding_source`.
- Attention : les vecteurs déjà stockés viennent de text-embedding-004. Ils sont dans un autre espace, donc il faut une ré-indexation complète avant de comparer les vecteurs.
- Ensuite, déployer uniquement `ml-feed-train`.
