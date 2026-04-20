-- 일정 확정(raid_type + 레이드 주 수요일 기준) + 확정 권한 Discord 핸들 allowlist
-- 멘션 봇용: raid_availability.discord_id (Discord snowflake)

alter table public.raid_availability
  add column if not exists discord_id text null;

comment on column public.raid_availability.discord_id is 'Discord 사용자 ID(snowflake). 출발 알림 봇에서 <@id> 멘션용';

-- ---------------------------------------------------------------------------
create table if not exists public.raid_schedule_confirm_allowlist (
  discord_username text primary key
);

comment on table public.raid_schedule_confirm_allowlist is
  '일정 확정 RPC 허용 Discord 로그인명(소문자 비교 시 preferred_username·name·full_name·global_name 중 하나와 일치)';

insert into public.raid_schedule_confirm_allowlist (discord_username)
values ('.yongi')
on conflict (discord_username) do nothing;

revoke all on public.raid_schedule_confirm_allowlist from public;

-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
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

do $$
begin
  alter publication supabase_realtime add table public.raid_schedule_confirmation;
exception
  when duplicate_object then null;
end $$;
