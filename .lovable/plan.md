# Diagnostic — comparaison workspace Lovable vs f806be98 (lecture seule, rien modifié)

## 1. SHA et parents

| Côté | SHA | Parent | Sujet |
|---|---|---|---|
| Workspace Lovable (HEAD) | `42102c79a52511ceba9c3776f11943bdf313025d` | `d0d3d4ebd13414936c6999a3a011196b5a47d4b2` | "Work in progress" |
| GitHub demandé | `f806be9858855a9bf4c15f548efac9aa55642fb6` | `8015397c3c6e700a5df355962868f7c0aae325cb` | "ci(supabase): deploy sealed sender transport" |

## 2. Merge-base

`f806be9858855a9bf4c15f548efac9aa55642fb6` — le commit GitHub est un **ancêtre direct** du HEAD du workspace. Aucune divergence : le workspace est strictement en avance.

## 3. Fichiers différents (A/M/D)

Un seul fichier diffère :

```
M  src/integrations/supabase/types.ts   (+3 / −59)
```

Contenu du diff : uniquement le fichier de types **auto-généré** par Lovable Cloud.
- Ajout : la table `sealed_sender_tokens` (créée par la migration `20260927172452_enable_sealed_sender_transport.sql`, déjà appliquée en production) + réordonnancement de colonnes dans `sealed_sender_messages`.
- Le `types.ts` embarqué dans f806be98 est simplement obsolète par rapport à l'état réel de la base.

## 4. Commits propres à chaque côté

- Propres au workspace (3) : `42102c79` "Work in progress", `d0d3d4eb` "Update plan", `5ab81624` "Work in progress" — tous ne touchent que `src/integrations/supabase/types.ts` (régénération automatique).
- Propres à f806be98 : **aucun**.

## 5. Correctifs produit absents de f806be98 ?

**Non.** Le workspace ne contient aucun correctif produit, aucune modification de code applicatif, de fonction Edge, de migration ou de configuration absente de f806be98. La seule avance est la régénération automatique des types TypeScript reflétant la migration sealed-sender déjà appliquée.

## Conséquence pour le déploiement sealed-mint-token / sealed-relay

Le blocage précédent est levé : le code des fonctions `sealed-mint-token` et `sealed-relay` présent dans le workspace est **identique** à celui de f806be98 (diff vide hors types.ts), et compatible avec la migration `20260927172452` déjà appliquée. Le déploiement demandé peut donc être exécuté depuis ce checkout sans écart de version.
