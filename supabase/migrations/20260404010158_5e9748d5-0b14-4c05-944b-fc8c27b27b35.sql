REVOKE EXECUTE ON FUNCTION public.match_contacts_by_phone(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(uuid, text[]) TO authenticated;