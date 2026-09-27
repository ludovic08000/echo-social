-- public_profiles predates field_visibility and can expose privacy-controlled
-- fields such as city without applying the viewer-aware profile RPC. The
-- application no longer consumes this legacy view, so keep it server-only.
REVOKE ALL PRIVILEGES ON TABLE public.public_profiles
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.public_profiles TO service_role;
