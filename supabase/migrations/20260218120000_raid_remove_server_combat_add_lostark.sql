-- server_name / 전투력 컬럼 제거, raid_type 에 lostark 추가
-- (기존 DB에 이미 컬럼이 없을 수 있으므로 IF EXISTS 사용)

alter table public.raid_availability drop column if exists combat_power;
alter table public.raid_availability drop column if exists combat_power_updated_at;
alter table public.raid_availability drop column if exists server_name;

do $$
begin
  alter table public.raid_availability drop constraint raid_availability_raid_type_check;
exception
  when undefined_object then null;
end $$;

alter table public.raid_availability
  add constraint raid_availability_raid_type_check
  check (raid_type in ('rudra', 'bagot', 'lostark'));
