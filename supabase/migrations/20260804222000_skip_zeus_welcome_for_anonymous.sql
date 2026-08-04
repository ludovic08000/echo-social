begin;

create or replace function public.zeus_welcome_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  zeus_id uuid := '00000000-0000-0000-0000-000000000001';
  conv_id uuid;
  welcome_wall text := '👋 Bienvenue sur Forsure ! Je suis Zeus, ton compagnon IA. N''hésite pas à me parler si tu as besoin d''aide ou simplement envie de discuter. Amuse-toi bien ! ⚡';
  welcome_dm text := 'Salut ' || coalesce(new.name, 'toi') || ' ! 👋 Je suis **Zeus**, ton assistant personnel sur Forsure. Je peux t''aider à découvrir la plateforme, répondre à tes questions, ou même créer du contenu pour toi. Écris-moi quand tu veux ! ⚡';
begin
  if exists (
    select 1
    from auth.users account
    where account.id = new.user_id
      and account.is_anonymous = true
  ) then
    return new;
  end if;

  insert into public.anonymous_wall_messages (author_id, target_user_id, message, is_approved)
  values (zeus_id, new.user_id, welcome_wall, true);

  insert into public.conversations (id, is_group, created_by)
  values (gen_random_uuid(), false, zeus_id)
  returning id into conv_id;

  insert into public.conversation_participants (conversation_id, user_id)
  values (conv_id, zeus_id), (conv_id, new.user_id);

  insert into public.messages (conversation_id, sender_id, body, status, body_kind)
  values (conv_id, zeus_id, welcome_dm, 'delivered', 'system');

  return new;
end;
$$;

commit;
