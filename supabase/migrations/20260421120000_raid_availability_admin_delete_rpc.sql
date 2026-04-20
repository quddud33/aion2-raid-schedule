-- 일정 확정 allowlist(raid_schedule_confirm_allowlist)와 동일한 JWT 핸들 검사로
-- 관리자만 타인의 raid_availability 행 삭제 (예: .yongi)

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
