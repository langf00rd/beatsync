-- run this once in your supabase project's sql editor before starting the sync script.
-- the whole file is safe to re-run: tables, indexes and policies already exist are
-- skipped (never recreated), and the function/trigger are created with `create or
-- replace` / `drop trigger if exists`, so nothing throws if run again.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  content text not null,
  hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, path)
);

-- added separately so an already-created table picks up the column too; on a
-- fresh install this just skips.
alter table public.documents add column if not exists created_at timestamptz not null default now();

alter table public.documents enable row level security;

-- each user only ever sees and touches their own rows. because the sync
-- script signs in with a real supabase auth session (not the service role
-- key), these policies are what actually enforce that isolation.
do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'select own documents'
  ) then
    create policy "select own documents"
      on public.documents for select
      using (auth.uid() = user_id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'insert own documents'
  ) then
    create policy "insert own documents"
      on public.documents for insert
      with check (auth.uid() = user_id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'update own documents'
  ) then
    create policy "update own documents"
      on public.documents for update
      using (auth.uid() = user_id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'documents'
      and policyname = 'delete own documents'
  ) then
    create policy "delete own documents"
      on public.documents for delete
      using (auth.uid() = user_id);
  end if;
end;
$$;

-- speeds up the per-user listing done on every startup (pullMissingFiles).
create index if not exists documents_user_id_idx on public.documents (user_id);

-- ---------------------------------------------------------------------------
-- app users
-- ---------------------------------------------------------------------------

-- one row per supabase auth user, holding the app-level profile info:
-- first/last name, email, and when they last signed in. the row is created
-- automatically by the handle_new_user() trigger below, so every auth user
-- that ever signs up has a row here.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  email text not null,
  created_at timestamptz not null default now(),
  last_login timestamptz not null default now(),
  -- fingerprint (hmac of the key, never the key itself) of the encryption
  -- key this user's documents were encrypted with. stored per user, so the
  -- same key works on any device: on a new device, entering the saved key
  -- matches this fingerprint and full access is granted. only a different
  -- (wrong) key — one that can't actually decrypt the documents — is
  -- rejected, before any document is decrypted or written.
  key_hash text
);

-- added separately so an already-created table picks up the column too; on a
-- fresh install this just skips.
alter table public.profiles add column if not exists created_at timestamptz not null default now();

alter table public.profiles add column if not exists key_hash text;

alter table public.profiles enable row level security;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'select own profile'
  ) then
    create policy "select own profile"
      on public.profiles for select
      using (auth.uid() = id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'insert own profile'
  ) then
    create policy "insert own profile"
      on public.profiles for insert
      with check (auth.uid() = id);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'update own profile'
  ) then
    create policy "update own profile"
      on public.profiles for update
      using (auth.uid() = id);
  end if;
end;
$$;

create index if not exists profiles_email_idx on public.profiles (email);

-- auto-create a profile row whenever a new auth user signs up. `create or
-- replace function` and `drop trigger if exists` keep this safe to re-run.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
