
-- Admin banned IPs table
CREATE TABLE public.banned_ips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text NOT NULL,
  reason text,
  banned_by uuid NOT NULL,
  banned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true
);

-- Admin banned users table
CREATE TABLE public.banned_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  reason text,
  banned_by uuid NOT NULL,
  banned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true
);

-- Connection/security logs
CREATE TABLE public.security_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  user_id uuid,
  ip_address text,
  user_agent text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Create user_roles table for admin access
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer function for role checking
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- RLS for user_roles
CREATE POLICY "Admins can manage roles" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS for banned tables (admin only)
ALTER TABLE public.banned_ips ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage banned IPs" ON public.banned_ips
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

ALTER TABLE public.banned_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage banned users" ON public.banned_users
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

ALTER TABLE public.security_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view security logs" ON public.security_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "System can insert security logs" ON public.security_logs
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Create indexes
CREATE INDEX idx_security_logs_created ON public.security_logs(created_at DESC);
CREATE INDEX idx_security_logs_event ON public.security_logs(event_type);
CREATE INDEX idx_banned_ips_ip ON public.banned_ips(ip_address);
CREATE INDEX idx_banned_users_user ON public.banned_users(user_id);
