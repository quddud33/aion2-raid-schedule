-- Discord 출발 알림 봇: 슬래시 명령으로 채널 ID 저장 (service_role 만 접근)

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
