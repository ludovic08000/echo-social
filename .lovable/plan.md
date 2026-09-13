# Diagnostic lecture seule — baseline manquante de `privacy_settings`

Aucune modification de code, de base ni de déploiement n'a été faite. Ce document rapporte les preuves et propose la réparation, à appliquer seulement sur votre accord.

## Constat

La table `public.privacy_settings` existe bien en production (projet Cloud), mais **aucun `CREATE TABLE` n'existe dans `supabase/migrations/`**. Les seules références SQL au dépôt sont des `ALTER TABLE` :

- `20260206052233_...sql` : `ADD COLUMN ghost_mode / detox_schedule / daily_limit_minutes` (c'est là que la CI casse)
- `20260310230658_...sql` : `ADD COLUMN IF NOT EXISTS wall_visibility`
- `20260403232233_...sql` : `REVOKE ALL ... FROM anon`
- `20260422041908_...sql` : `ADD COLUMN ai_personalization_enabled`
- `20260422052252_...sql` : `ADD COLUMN ai_data_sharing_enabled`

Donc `supabase db reset` échoue nécessairement à la première migration qui suppose la table déjà créée. Le fichier `.github/workflows/repair-privacy-baseline.yml` patche ce fichier au vol en CI : c'est un contournement, pas un correctif d'historique.

## Schéma réel constaté (source : requêtes lecture seule sur le projet Cloud)

Sources exactes : `information_schema.columns`, `pg_constraint`, `pg_indexes`, `pg_policies`, `pg_trigger`, `pg_class.relacl` + `has_table_privilege`.

Colonnes dans l'ordre réel (1→13 = baseline ; 14→19 ajoutées par les migrations existantes) :

```text
 1 id                          uuid        NOT NULL  default gen_random_uuid()
 2 user_id                     uuid        NOT NULL
 3 profile_visibility          text        NOT NULL  default 'public'
 4 posts_visibility            text        NOT NULL  default 'public'
 5 comments_allowed            text        NOT NULL  default 'everyone'
 6 likes_visibility            text        NOT NULL  default 'public'
 7 messages_allowed            text        NOT NULL  default 'everyone'
 8 friends_list_visibility     text        NOT NULL  default 'friends'
 9 online_status_visibility    text        NOT NULL  default 'friends'
10 search_engine_indexing      boolean     NOT NULL  default false
11 analytics_enabled           boolean     NOT NULL  default false
12 created_at                  timestamptz NOT NULL  default now()
13 updated_at                  timestamptz NOT NULL  default now()
-- ajoutées ensuite par les migrations existantes :
14 ghost_mode                  boolean     NOT NULL  default false        (20260206052233)
15 detox_schedule              jsonb       NULL                           (20260206052233)
16 daily_limit_minutes         integer     NULL                           (20260206052233)
17 wall_visibility             text        NOT NULL  default 'friends'    (20260310230658)
18 ai_personalization_enabled  boolean     NOT NULL  default true         (20260422041908)
19 ai_data_sharing_enabled     boolean     NOT NULL  default true         (20260422052252)
```

Contraintes : PK `(id)`, UNIQUE `(user_id)` (pas de FK vers `auth.users`), et 7 CHECK :
`profile_visibility`, `posts_visibility`, `likes_visibility`, `friends_list_visibility` ∈ `('public','friends','private')` ;
`comments_allowed`, `messages_allowed`, `online_status_visibility` ∈ `('everyone','friends','nobody')`.

Index : uniquement les index implicites `privacy_settings_pkey` et `privacy_settings_user_id_key`.

RLS : activée (`relrowsecurity = true`, `force` = false). 3 policies PERMISSIVE, rôle `public` :
`SELECT` / `UPDATE` avec `USING (auth.uid() = user_id)`, `INSERT` avec `WITH CHECK (auth.uid() = user_id)`. Aucune policy `DELETE`.

Trigger : `update_privacy_settings_updated_at BEFORE UPDATE FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`.

Grants réels : `authenticated` = SELECT/INSERT/UPDATE/DELETE (+TRUNCATE/REFERENCES/TRIGGER), `service_role` = ALL, `anon` = **aucun** (cohérent avec le `REVOKE` de `20260403232233`).

## Réparation proposée (non appliquée)

1. Ajouter une **nouvelle migration baseline** horodatée avant `20260206052233`, contenant le `CREATE TABLE` ci-dessus (colonnes 1→13 uniquement, dans cet ordre), les CHECK, la PK, l'UNIQUE, `ENABLE ROW LEVEL SECURITY`, les 3 policies, le trigger `updated_at`, et les GRANTs (`authenticated` SELECT/INSERT/UPDATE/DELETE, `service_role` ALL, rien pour `anon`).
2. Rendre idempotents les `ADD COLUMN` de `20260206052233` (`IF NOT EXISTS`) pour que l'historique rejoue proprement sur une base déjà pourvue.
3. Supprimer `.github/workflows/repair-privacy-baseline.yml` une fois l'historique réparé, le patch au vol devenant inutile.
4. Ne rien appliquer sur la base de production : la table y existe déjà à l'identique ; la baseline sert uniquement au `supabase db reset` de CI.

## Vérification attendue après correction

- `supabase db reset` puis `supabase test db` verts en CI ;
- comparaison colonne à colonne du schéma reconstruit avec le tableau ci-dessus ;
- aucune écriture sur la base de production.

## Réserve explicite

La messagerie interplateforme n'est **pas** déclarée validée : les envois, déchiffrements et affichages bidirectionnels réels (Windows↔iOS) restent à vérifier séparément.
