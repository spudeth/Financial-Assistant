-- Per-user assistant profile. A single compact, self-maintained note the chat
-- persona reads on every turn (the "who you're talking to" framing) and the
-- background memory-writer rewrites after each reply. One row per user; content
-- is plain text the model curates for itself and is kept small on purpose.

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  content text not null default '',
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "own rows" on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());
