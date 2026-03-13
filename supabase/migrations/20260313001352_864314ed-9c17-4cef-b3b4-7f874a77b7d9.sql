
-- Enable trigram extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Full-text search: GIN indexes on profiles.name and posts.body
CREATE INDEX IF NOT EXISTS idx_profiles_name_trgm ON public.profiles USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_body_trgm ON public.posts USING gin (body gin_trgm_ops);

-- Composite index for search results enrichment
CREATE INDEX IF NOT EXISTS idx_profiles_user_id_name_avatar ON public.profiles (user_id) INCLUDE (name, avatar_url);
