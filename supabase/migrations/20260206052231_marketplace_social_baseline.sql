-- Baseline reconstruite depuis le schéma réel de production (Lovable Cloud).
-- Invariant corrigé : ces tables existent en production mais n'étaient créées
-- par aucune migration, ce qui cassait tout reset à neuf (supabase db reset).

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('admin','moderator','user'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.friendship_status AS ENUM ('pending','accepted','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.notification_type AS ENUM ('like','comment','reaction','friend_request','friend_accepted','message','story_view','sale','new_device'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.order_status AS ENUM ('pending','paid','processing','shipped','delivered','cancelled','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.product_type AS ENUM ('physical','digital','service'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.reaction_type AS ENUM ('like','love','haha','wow','sad','angry'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  reason text,
  status text DEFAULT 'pending'::text NOT NULL,
  confirmation_token uuid DEFAULT gen_random_uuid(),
  scheduled_deletion_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  confirmed_at timestamp with time zone,
  completed_at timestamp with time zone
);

CREATE TABLE IF NOT EXISTS public.cart_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.group_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text DEFAULT 'member'::text NOT NULL,
  joined_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.groups (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  cover_image_url text,
  privacy text DEFAULT 'public'::text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid,
  seller_id uuid NOT NULL,
  title text NOT NULL,
  price numeric(10,2) NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  commission_amount numeric(12,2) NOT NULL,
  seller_payout numeric(12,2) NOT NULL,
  status public.order_status DEFAULT 'pending'::order_status NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  buyer_id uuid NOT NULL,
  order_number text NOT NULL,
  status public.order_status DEFAULT 'pending'::order_status NOT NULL,
  subtotal numeric(12,2) NOT NULL,
  commission_rate numeric(5,4) DEFAULT 0.15 NOT NULL,
  commission_amount numeric(12,2) NOT NULL,
  total numeric(12,2) NOT NULL,
  shipping_address jsonb,
  payment_intent_id text,
  paid_at timestamp with time zone,
  shipped_at timestamp with time zone,
  delivered_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  shipping_method text DEFAULT 'standard'::text,
  shipping_relay_id text,
  shipping_relay_name text,
  shipping_relay_address text,
  shipping_relay_postcode text,
  shipping_relay_city text,
  shipping_relay_country text DEFAULT 'FR'::text,
  tracking_number text,
  shipping_label_url text,
  shipping_weight_grams integer DEFAULT 500,
  packing_video_url text,
  packing_video_status text DEFAULT 'none'::text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.page_admins (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  page_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text DEFAULT 'admin'::text NOT NULL,
  added_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  category text DEFAULT 'general'::text NOT NULL,
  description text,
  cover_image_url text,
  profile_image_url text,
  website_url text,
  phone text,
  email text,
  address text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  seller_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  price numeric(10,2) NOT NULL,
  compare_at_price numeric(10,2),
  product_type public.product_type DEFAULT 'physical'::product_type NOT NULL,
  category text DEFAULT 'general'::text NOT NULL,
  tags text[] DEFAULT '{}'::text[],
  images text[] DEFAULT '{}'::text[],
  thumbnail_url text,
  stock_quantity integer,
  is_active boolean DEFAULT true NOT NULL,
  is_featured boolean DEFAULT false NOT NULL,
  digital_file_url text,
  view_count integer DEFAULT 0 NOT NULL,
  order_count integer DEFAULT 0 NOT NULL,
  rating_average numeric(3,2) DEFAULT NULL::numeric,
  rating_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  size text,
  color text,
  shipping_type text DEFAULT 'standard'::text NOT NULL,
  shipping_price numeric DEFAULT 0,
  country text DEFAULT 'FR'::text,
  region text,
  city text,
  weight_grams integer,
  condition text DEFAULT 'good'::text
);

CREATE TABLE IF NOT EXISTS public.seller_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  store_name text NOT NULL,
  store_description text,
  store_logo_url text,
  store_banner_url text,
  is_verified boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  total_sales integer DEFAULT 0 NOT NULL,
  total_revenue numeric(12,2) DEFAULT 0 NOT NULL,
  rating_average numeric(3,2) DEFAULT NULL::numeric,
  rating_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.tips (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tipper_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  amount numeric NOT NULL,
  commission_amount numeric NOT NULL,
  creator_payout numeric NOT NULL,
  commission_rate numeric DEFAULT 0.15 NOT NULL,
  stripe_session_id text,
  status text DEFAULT 'pending'::text NOT NULL,
  message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN ALTER TABLE public.account_deletion_requests ADD CONSTRAINT account_deletion_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'completed'::text, 'cancelled'::text]))); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.account_deletion_requests ADD CONSTRAINT account_deletion_requests_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_quantity_check CHECK ((quantity > 0)); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.cart_items ADD CONSTRAINT cart_items_user_id_product_id_key UNIQUE (user_id, product_id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.group_members ADD CONSTRAINT group_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'moderator'::text, 'member'::text]))); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.group_members ADD CONSTRAINT group_members_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.group_members ADD CONSTRAINT group_members_group_id_user_id_key UNIQUE (group_id, user_id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.groups ADD CONSTRAINT groups_privacy_check CHECK ((privacy = ANY (ARRAY['public'::text, 'private'::text, 'secret'::text]))); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.groups ADD CONSTRAINT groups_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.orders ADD CONSTRAINT orders_order_number_key UNIQUE (order_number); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.page_admins ADD CONSTRAINT page_admins_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.page_admins ADD CONSTRAINT page_admins_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'editor'::text, 'moderator'::text]))); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.page_admins ADD CONSTRAINT page_admins_page_id_user_id_key UNIQUE (page_id, user_id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.pages ADD CONSTRAINT pages_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.products ADD CONSTRAINT products_price_check CHECK ((price >= (0)::numeric)); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.products ADD CONSTRAINT products_compare_at_price_check CHECK ((compare_at_price >= (0)::numeric)); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.seller_profiles ADD CONSTRAINT seller_profiles_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.seller_profiles ADD CONSTRAINT seller_profiles_user_id_key UNIQUE (user_id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.tips ADD CONSTRAINT tips_pkey PRIMARY KEY (id); EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL; END $$;

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_deletion_requests TO authenticated;
GRANT ALL ON public.account_deletion_requests TO service_role;
ALTER TABLE public.cart_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cart_items TO authenticated;
GRANT ALL ON public.cart_items TO service_role;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_members TO authenticated;
GRANT ALL ON public.group_members TO service_role;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.groups TO authenticated;
GRANT ALL ON public.groups TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.page_admins ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.page_admins TO authenticated;
GRANT ALL ON public.page_admins TO service_role;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pages TO authenticated;
GRANT ALL ON public.pages TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.seller_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seller_profiles TO authenticated;
GRANT ALL ON public.seller_profiles TO service_role;
ALTER TABLE public.tips ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tips TO authenticated;
GRANT ALL ON public.tips TO service_role;
