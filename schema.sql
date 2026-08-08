-- Run this once in your Supabase project's SQL editor before starting the sync script.

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  content text not null,
  hash text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, path)
);

alter table public.documents enable row level security;

-- Each user only ever sees and touches their own rows. Because the sync
-- script signs in with a real Supabase Auth session (not the service role
-- key), these policies are what actually enforce that isolation.
create policy "select own documents"
  on public.documents for select
  using (auth.uid() = user_id);

create policy "insert own documents"
  on public.documents for insert
  with check (auth.uid() = user_id);

create policy "update own documents"
  on public.documents for update
  using (auth.uid() = user_id);

create policy "delete own documents"
  on public.documents for delete
  using (auth.uid() = user_id);

-- Speeds up the per-user listing done on every startup (pullMissingFiles).
create index if not exists documents_user_id_idx on public.documents (user_id);
