-- ============================================================================
-- À EXÉCUTER DANS L'ÉDITEUR SQL DE SUPABASE (Dashboard → SQL Editor → New query)
-- Aucun CLI Supabase requis. Copie/colle tout, puis "Run".
--
-- Correctif de sécurité C1 — les secrets Sender Key ne doivent jamais être
-- stockés côté serveur. La clé de chaîne (chain_key_b64) dérive TOUTES les clés
-- de message de groupe ; la clé privée de signature (signing_priv_jwk) permet
-- de forger des messages. Le client les garde désormais uniquement en local.
-- Cette requête supprime ces deux colonnes secrètes du serveur.
--
-- Sans danger : idempotent (IF EXISTS). Le serveur conserve les colonnes NON
-- secrètes (ids, is_owner, signing_pub_b64 PUBLIC, iteration).
-- ============================================================================

ALTER TABLE public.sender_key_state DROP COLUMN IF EXISTS chain_key_b64;
ALTER TABLE public.sender_key_state DROP COLUMN IF EXISTS signing_priv_jwk;

-- Vérification (optionnel) : ne doit PLUS lister chain_key_b64 ni signing_priv_jwk
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'sender_key_state'
-- ORDER BY ordinal_position;
