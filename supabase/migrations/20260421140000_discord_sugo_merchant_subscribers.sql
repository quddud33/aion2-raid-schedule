-- 슈고 상인 보호(슈상보) 알림: 사용자가 등록한 채널에서 짝수 시 정각(06~08시 제외) 멘션

create table if not exists public.discord_sugo_merchant_subscribers (
  guild_id text not null,
  channel_id text not null,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, discord_user_id)
);

create index if not exists discord_sugo_merchant_subscribers_guild_idx
  on public.discord_sugo_merchant_subscribers (guild_id);

create index if not exists discord_sugo_merchant_subscribers_channel_idx
  on public.discord_sugo_merchant_subscribers (channel_id);

comment on table public.discord_sugo_merchant_subscribers is
  '슈상보 알림 봇: 길드당 1행(등록 채널에서 짝수 시 정각 멘션). service_role 로만 접근 권장';

alter table public.discord_sugo_merchant_subscribers enable row level security;

revoke all on public.discord_sugo_merchant_subscribers from anon, authenticated;
