begin;

alter table public.user_known_fingerprints
  add column if not exists trust_version integer,
  add column if not exists observer_signature text;

-- Legacy rows are unsigned and therefore cannot be used as a cross-device trust
-- authority. Device-local continuity remains untouched.
delete from public.user_known_fingerprints
where trust_version is distinct from 1
   or nullif(trim(observer_signature), '') is null;

alter table public.user_known_fingerprints
  alter column trust_version set default 1,
  alter column trust_version set not null,
  alter column observer_signature set not null;

alter table public.user_known_fingerprints
  drop constraint if exists user_known_fingerprints_trust_version_check;
alter table public.user_known_fingerprints
  add constraint user_known_fingerprints_trust_version_check
  check (trust_version = 1);

alter table public.user_known_fingerprints
  drop constraint if exists user_known_fingerprints_observer_signature_check;
alter table public.user_known_fingerprints
  add constraint user_known_fingerprints_observer_signature_check
  check (length(observer_signature) between 80 and 180);

comment on column public.user_known_fingerprints.observer_signature is
  'Ed25519 signature by the observer account identity over peer fingerprint and trust flags.';

commit;
