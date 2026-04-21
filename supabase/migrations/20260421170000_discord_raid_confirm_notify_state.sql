-- 레이드 일정 확정 직후 디스코드 알림: 재시작 시 로컬 JSON 없이도 중복 전송 방지

create table if not exists public.discord_raid_confirm_notify_state (
  raid_type text not null check (raid_type in ('rudra', 'bagot', 'lostark')),
  raid_week_start date not null,
  last_notified_updated_at_ms bigint not null,
  updated_at timestamptz not null default now(),
  primary key (raid_type, raid_week_start)
);

comment on table public.discord_raid_confirm_notify_state is
  '확정 직후 알림 전송 시점의 raid_schedule_confirmation.updated_at(ms). 봇 service_role 전용';

alter table public.discord_raid_confirm_notify_state enable row level security;

revoke all on public.discord_raid_confirm_notify_state from anon, authenticated;
