-- 파티 구인 (디스코드 봇): 파티장 1 + 멤버 최대 7 = 총 8인

create table if not exists public.discord_party_recruit (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  message_id text not null,
  leader_id text not null,
  member_ids text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'departed', 'disbanded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discord_party_recruit_member_ids_max check (cardinality(member_ids) <= 7)
);

create unique index if not exists discord_party_recruit_message_id_uniq
  on public.discord_party_recruit (message_id);

-- 길드당 파티장당 열린 파티 1개
create unique index if not exists discord_party_recruit_one_open_per_leader
  on public.discord_party_recruit (guild_id, leader_id)
  where (status = 'open');

comment on table public.discord_party_recruit is
  '파티 구인 메시지·버튼 상태. 봇 service_role 전용.';

alter table public.discord_party_recruit enable row level security;

revoke all on public.discord_party_recruit from anon, authenticated;
