-- 기존 프로젝트: Supabase SQL Editor 또는 supabase db push 로 적용
alter table public.raid_availability
  add column if not exists combat_power text null;

alter table public.raid_availability
  add column if not exists combat_power_updated_at timestamptz null;
