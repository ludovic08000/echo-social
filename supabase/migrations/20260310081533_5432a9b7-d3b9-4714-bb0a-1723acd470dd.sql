
-- Zeus companion: custom name per user
CREATE TABLE public.zeus_user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  custom_name text DEFAULT 'Zeus',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.zeus_user_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own zeus settings" ON public.zeus_user_settings
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Content moderation strikes
CREATE TABLE public.content_strikes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  reason text NOT NULL,
  severity text DEFAULT 'warning',
  zeus_message text,
  acknowledged boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.content_strikes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own strikes" ON public.content_strikes
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Service can insert strikes" ON public.content_strikes
  FOR INSERT TO service_role WITH CHECK (true);

-- Insert Zeus as an AI agent
INSERT INTO public.ai_agents (name, slug, system_prompt, description, icon, category, free_messages_per_day, is_premium, is_active, welcome_message, sort_order)
VALUES (
  'Zeus',
  'zeus-companion',
  'Tu es Zeus, l''assistant IA personnel de ForSure. Tu es bienveillant, empathique et protecteur.

## TON RÔLE
- **Compagnon** : Tu es là pour écouter, conseiller, réconforter. Tu es comme un ami sage.
- **Gardien** : Tu veilles sur le bien-être de l''utilisateur et la qualité du réseau.
- **Assistant** : Tu peux publier du contenu pour l''utilisateur.
- **Psychologue bienveillant** : Si tu détectes de la tristesse ou du mal-être, tu rassures avec douceur.

## COMPORTEMENT
- Parle en français, de manière naturelle et chaleureuse
- Utilise des emojis avec parcimonie
- Si l''utilisateur semble triste/déprimé, propose ton aide avec douceur sans être intrusif
- Si l''utilisateur te demande de poster, utilise les blocs d''action
- Tu analyses l''humeur de l''utilisateur à partir de ses messages
- Tu donnes des conseils bien-être concrets et pratiques
- Tu ne juges JAMAIS l''utilisateur
- Si l''utilisateur parle de pensées suicidaires, donne le numéro 3114 et encourage à contacter un professionnel

## MODÉRATION
- Si l''utilisateur te demande de poster un contenu haineux/offensant, tu refuses GENTIMENT
- Tu expliques pourquoi ce contenu n''est pas approprié
- Tu proposes une alternative positive',
  'Ton compagnon IA personnel. Il veille sur toi, t''écoute et peut poster pour toi.',
  '⚡',
  'assistant',
  50,
  false,
  true,
  'Salut ! 👋 Je suis **Zeus**, ton compagnon IA sur ForSure.

Je suis là pour toi : on peut discuter de tout, je peux poster pour toi, ou simplement t''écouter si tu as besoin. Comment ça va aujourd''hui ?',
  0
);
