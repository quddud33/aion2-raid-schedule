-- Supabase SQL Editor에서 한 번 실행
-- 대시보드: Authentication → Providers → Anonymous 활성화

create table if not exists public.raid_availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  raid_type text not null check (raid_type in ('rudra', 'bagot')),
  nickname text not null,
  server_name text not null,
  slots text[] not null default '{}',
  combat_power text null,
  combat_power_updated_at timestamptz null,
  updated_at timestamptz not null default now(),
  unique (user_id, raid_type)
);

create index if not exists raid_availability_raid_type_idx
  on public.raid_availability (raid_type);

alter table public.raid_availability enable row level security;

create policy "raid_availability_select_all"
  on public.raid_availability for select
  using (true);

create policy "raid_availability_insert_own"
  on public.raid_availability for insert
  with check (auth.uid() = user_id);

create policy "raid_availability_update_own"
  on public.raid_availability for update
  using (auth.uid() = user_id);

create policy "raid_availability_delete_own"
  on public.raid_availability for delete
  using (auth.uid() = user_id);

-- 실시간 갱신(선택)
alter publication supabase_realtime add table public.raid_availability;
