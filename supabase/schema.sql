create table if not exists public.roundtable_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  question text not null,
  theme text not null,
  tension text not null,
  selected_pioneer_ids text[] not null default '{}',
  stage text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roundtable_messages (
  id uuid primary key,
  session_id uuid not null references public.roundtable_sessions(id) on delete cascade,
  role text not null,
  speaker_id text not null,
  stage text not null,
  content text not null,
  quote text,
  source_note_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.action_cards (
  session_id uuid primary key references public.roundtable_sessions(id) on delete cascade,
  within_24h text not null,
  seven_day_experiment text not null,
  thirty_day_practice text not null,
  evidence_to_review text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_cards (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.roundtable_sessions(id) on delete cascade,
  quote text not null,
  speaker_id text not null,
  context text not null,
  created_at timestamptz not null default now()
);

alter table public.roundtable_sessions enable row level security;
alter table public.roundtable_messages enable row level security;
alter table public.action_cards enable row level security;
alter table public.quote_cards enable row level security;

create policy "Users can read own sessions"
  on public.roundtable_sessions for select
  using (auth.uid() = user_id);

create policy "Users can insert own sessions"
  on public.roundtable_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own sessions"
  on public.roundtable_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can read own messages"
  on public.roundtable_messages for select
  using (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = roundtable_messages.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );

create policy "Users can insert own messages"
  on public.roundtable_messages for insert
  with check (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = roundtable_messages.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );

create policy "Users can read own action cards"
  on public.action_cards for select
  using (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = action_cards.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );

create policy "Users can insert own action cards"
  on public.action_cards for insert
  with check (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = action_cards.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );

create policy "Users can read own quote cards"
  on public.quote_cards for select
  using (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = quote_cards.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );

create policy "Users can insert own quote cards"
  on public.quote_cards for insert
  with check (
    exists (
      select 1 from public.roundtable_sessions
      where roundtable_sessions.id = quote_cards.session_id
      and roundtable_sessions.user_id = auth.uid()
    )
  );
