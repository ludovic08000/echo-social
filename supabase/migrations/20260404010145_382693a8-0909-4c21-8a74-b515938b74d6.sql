REVOKE EXECUTE ON FUNCTION public.match_contacts_by_phone(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(text[]) TO authenticated;