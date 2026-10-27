create table if not exists public.voice_session_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_hash text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  nonce text not null,
  allowed_origin text not null,
  audience text not null default 'forsure-voice',
  permissions jsonb not null default '["publish_post","send_message","update_feed_config"]'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint voice_ticket_origin_https check (allowed_origin ~ '^https://[^/]+$'),
  constraint voice_ticket_nonce_length check (length(nonce) between 32 and 128),
  constraint voice_ticket_expiry_window check (expires_at > created_at and expires_at <= created_at + interval '2 minutes')
);

alter table public.voice_session_tickets enable row level security;
revoke all on public.voice_session_tickets from anon, authenticated;
grant select, insert, update, delete on public.voice_session_tickets to service_role;

create index if not exists voice_session_tickets_expiry_idx
  on public.voice_session_tickets (expires_at);

create or replace function public.consume_voice_session_ticket(
  p_ticket_hash text,
  p_origin text,
  p_audience text
)
returns table(user_id uuid, nonce text, permissions jsonb)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.voice_session_tickets
     set consumed_at = now()
   where ticket_hash = p_ticket_hash
     and allowed_origin = p_origin
     and audience = p_audience
     and consumed_at is null
     and expires_at > now()
  returning voice_session_tickets.user_id, voice_session_tickets.nonce, voice_session_tickets.permissions;
$$;

revoke all on function public.consume_voice_session_ticket(text, text, text) from public, anon, authenticated;
grant execute on function public.consume_voice_session_ticket(text, text, text) to service_role;
