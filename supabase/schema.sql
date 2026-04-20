-- Supabase SQL Editor에서 실행
-- 대시보드: Authentication → Providers → Discord 활성화 (Client ID/Secret)
-- Redirect URLs: 로컬·GitHub Pages 배포 URL + Vite base 경로 (예: https://user.github.io/repo/)
--
-- 이미 적용된 DB에서 다시 실행해도 되도록 RLS 정책은 DROP 후 CREATE 합니다.

create table if not exists public.raid_availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  raid_type text not null check (raid_type in ('rudra', 'bagot', 'lostark')),
  nickname text not null,
  avatar_url text null,
  slots text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (user_id, raid_type)
);

create index if not exists raid_availability_raid_type_idx
  on public.raid_availability (raid_type);

alter table public.raid_availability enable row level security;

drop policy if exists "raid_availability_select_all" on public.raid_availability;
create policy "raid_availability_select_all"
  on public.raid_availability for select
  using (true);

drop policy if exists "raid_availability_insert_own" on public.raid_availability;
create policy "raid_availability_insert_own"
  on public.raid_availability for insert
  with check (auth.uid() = user_id);

drop policy if exists "raid_availability_update_own" on public.raid_availability;
create policy "raid_availability_update_own"
  on public.raid_availability for update
  using (auth.uid() = user_id);

drop policy if exists "raid_availability_delete_own" on public.raid_availability;
create policy "raid_availability_delete_own"
  on public.raid_availability for delete
  using (auth.uid() = user_id);

do $$
begin
  alter publication supabase_realtime add table public.raid_availability;
exception
  when duplicate_object then null;
end $$;
