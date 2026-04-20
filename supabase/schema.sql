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
  discord_id text null,
  slots text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (user_id, raid_type)
);

comment on column public.raid_availability.discord_id is 'Discord 사용자 ID(snowflake). 출발 알림 봇에서 <@id> 멘션용';

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

-- ---------------------------------------------------------------------------
-- 일정 확정 (마이그레이션 20260218150000 과 동일 개념)

create table if not exists public.raid_schedule_confirm_allowlist (
  discord_username text primary key
);

insert into public.raid_schedule_confirm_allowlist (discord_username)
values ('.yongi')
on conflict (discord_username) do nothing;

revoke all on public.raid_schedule_confirm_allowlist from public;

create table if not exists public.raid_schedule_confirmation (
  raid_type text not null check (raid_type in ('rudra', 'bagot', 'lostark')),
  raid_week_start date not null,
  slot_key text not null,
  confirmed_by uuid not null references auth.users (id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (raid_type, raid_week_start),
  constraint raid_schedule_confirmation_slot_key_fmt check (slot_key ~ '^\d{4}-\d{2}-\d{2}@\d{4}$')
);

create index if not exists raid_schedule_confirmation_raid_type_idx
  on public.raid_schedule_confirmation (raid_type);

alter table public.raid_schedule_confirmation enable row level security;

drop policy if exists "raid_schedule_confirmation_select_all" on public.raid_schedule_confirmation;
create policy "raid_schedule_confirmation_select_all"
  on public.raid_schedule_confirmation for select
  using (true);

revoke insert, update, delete on public.raid_schedule_confirmation from anon;
revoke insert, update, delete on public.raid_schedule_confirmation from authenticated;

create or replace function public._jwt_schedule_confirm_handles_match()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.raid_schedule_confirm_allowlist a
    where
      lower(trim(a.discord_username)) = lower(trim(coalesce((auth.jwt()->'user_metadata'->>'preferred_username'), '')))
      or lower(trim(a.discord_username)) = lower(trim(coalesce((auth.jwt()->'user_metadata'->>'name'), '')))
      or lower(trim(a.discord_username)) = lower(trim(coalesce((auth.jwt()->'user_metadata'->>'full_name'), '')))
      or lower(trim(a.discord_username)) = lower(trim(coalesce((auth.jwt()->'user_metadata'->>'global_name'), '')))
  );
$$;

create or replace function public.can_confirm_schedule()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public._jwt_schedule_confirm_handles_match();
$$;

grant execute on function public.can_confirm_schedule() to authenticated;

create or replace function public.upsert_schedule_confirmation(
  p_raid_type text,
  p_raid_week_start date,
  p_slot_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '28000';
  end if;
  if p_raid_type not in ('rudra', 'bagot', 'lostark') then
    raise exception 'invalid raid_type';
  end if;
  if not public._jwt_schedule_confirm_handles_match() then
    raise exception 'not allowed to confirm schedule' using errcode = '42501';
  end if;
  if p_slot_key is null or p_slot_key !~ '^\d{4}-\d{2}-\d{2}@\d{4}$' then
    raise exception 'invalid slot_key';
  end if;

  insert into public.raid_schedule_confirmation (raid_type, raid_week_start, slot_key, confirmed_by, updated_at)
  values (p_raid_type, p_raid_week_start, p_slot_key, auth.uid(), now())
  on conflict (raid_type, raid_week_start) do update
  set
    slot_key = excluded.slot_key,
    confirmed_by = excluded.confirmed_by,
    updated_at = excluded.updated_at;
end;
$$;

grant execute on function public.upsert_schedule_confirmation(text, date, text) to authenticated;

create or replace function public.clear_schedule_confirmation(
  p_raid_type text,
  p_raid_week_start date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '28000';
  end if;
  if p_raid_type not in ('rudra', 'bagot', 'lostark') then
    raise exception 'invalid raid_type';
  end if;
  if not public._jwt_schedule_confirm_handles_match() then
    raise exception 'not allowed to confirm schedule' using errcode = '42501';
  end if;

  delete from public.raid_schedule_confirmation
  where raid_type = p_raid_type and raid_week_start = p_raid_week_start;
end;
$$;

grant execute on function public.clear_schedule_confirmation(text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 관리자: 타인 raid_availability 행 삭제 (일정 확정과 동일 allowlist, 예: .yongi)

create or replace function public.delete_raid_availability_as_admin(p_row_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'auth required' using errcode = '28000';
  end if;
  if not public._jwt_schedule_confirm_handles_match() then
    raise exception 'not allowed to delete availability row' using errcode = '42501';
  end if;
  if p_row_id is null then
    raise exception 'invalid row id';
  end if;

  delete from public.raid_availability
  where id = p_row_id;

  if not found then
    raise exception 'raid_availability row not found' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.delete_raid_availability_as_admin(uuid) is
  'Discord 핸들 allowlist(일정 확정과 동일) 사용자만 타인 가능 시간 행 삭제';

grant execute on function public.delete_raid_availability_as_admin(uuid) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.raid_schedule_confirmation;
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Discord 알림 봇 채널 (마이그레이션 20260420180000 과 동일)

create table if not exists public.discord_reminder_channel_config (
  id text primary key default 'default',
  default_channel_id text null,
  rudra_channel_id text null,
  bagot_channel_id text null,
  lostark_channel_id text null,
  updated_at timestamptz not null default now()
);

comment on table public.discord_reminder_channel_config is
  '알림 봇 채널. 비어 있으면 봇 .env 의 DISCORD_CHANNEL_ID* 사용. 봇이 service_role 로 읽기/쓰기';

alter table public.discord_reminder_channel_config enable row level security;

revoke all on public.discord_reminder_channel_config from anon, authenticated;
