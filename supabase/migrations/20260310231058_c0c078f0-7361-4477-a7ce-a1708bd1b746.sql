
-- Zeus welcome: post on anonymous wall + send DM when a new profile is created
CREATE OR REPLACE FUNCTION public.zeus_welcome_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  zeus_id UUID := '00000000-0000-0000-0000-000000000001';
  conv_id UUID;
  welcome_wall TEXT := '👋 Bienvenue sur Forsure ! Je suis Zeus, ton compagnon IA. N''hésite pas à me parler si tu as besoin d''aide ou simplement envie de discuter. Amuse-toi bien ! ⚡';
  welcome_dm TEXT := 'Salut ' || COALESCE(NEW.name, 'toi') || ' ! 👋 Je suis **Zeus**, ton assistant personnel sur Forsure. Je peux t''aider à découvrir la plateforme, répondre à tes questions, ou même créer du contenu pour toi. Écris-moi quand tu veux ! ⚡';
BEGIN
  -- 1) Post welcome message on the user's anonymous wall (auto-approved)
  INSERT INTO anonymous_wall_messages (author_id, target_user_id, message, is_approved)
  VALUES (zeus_id, NEW.user_id, welcome_wall, true);

  -- 2) Create a DM conversation between Zeus and the new user
  INSERT INTO conversations (id, is_group, created_by)
  VALUES (gen_random_uuid(), false, zeus_id)
  RETURNING id INTO conv_id;

  -- Add both participants
  INSERT INTO conversation_participants (conversation_id, user_id)
  VALUES (conv_id, zeus_id), (conv_id, NEW.user_id);

  -- Send the welcome DM
  INSERT INTO messages (conversation_id, sender_id, body, status)
  VALUES (conv_id, zeus_id, welcome_dm, 'delivered');

  RETURN NEW;
END;
$$;

-- Trigger after profile creation
CREATE TRIGGER on_new_profile_zeus_welcome
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.zeus_welcome_new_user();
