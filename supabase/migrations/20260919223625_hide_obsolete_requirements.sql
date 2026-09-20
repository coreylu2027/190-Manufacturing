begin;
alter table manufacturing.requirements
  add column hidden boolean not null default false,
  add column visibility_version bigint not null default 0,
  add column visibility_changed_at timestamptz,
  add column visibility_changed_by text,
  add constraint hidden_requirements_are_obsolete check (not hidden or obsolete);

-- Restoring work always makes it visible again and invalidates stale hide Undo.
create function manufacturing.unhide_restored_requirement() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not new.obsolete and old.obsolete then
    new.hidden := false;
    new.visibility_version := old.visibility_version+1;
    new.visibility_changed_at := clock_timestamp();
    new.visibility_changed_by := new.obsoletion_changed_by;
  end if;
  return new;
end;
$$;
revoke all on function manufacturing.unhide_restored_requirement() from public,anon,authenticated,service_role;
create trigger unhide_restored_requirement before update of obsolete on manufacturing.requirements
  for each row execute function manufacturing.unhide_restored_requirement();

create function public.manufacturing_set_requirement_hidden(
  p_request_id uuid, p_actor uuid, p_expected text, p_requirement_id bigint,
  p_hidden boolean, p_version bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior manufacturing.write_requests; fingerprint text; before_row jsonb; after_row jsonb;
  result jsonb; actor_name text;
begin
  set local lock_timeout = '5s';
  lock table manufacturing.write_control, manufacturing.write_requests,
    manufacturing.requirements, manufacturing.write_history in share row exclusive mode;
  if not exists(select 1 from manufacturing.write_control where enabled) then
    raise exception 'Supabase manufacturing writes are disabled' using errcode='42501';
  end if;
  select display_name into actor_name from public.profiles where id=p_actor and approved and role='admin' for share;
  if not found then raise exception 'Approved administrator required' using errcode='42501'; end if;
  if p_request_id is null or p_hidden is null or p_version is null or p_version < 0 then
    raise exception 'Invalid visibility request';
  end if;
  fingerprint := md5(jsonb_build_array(p_actor,p_expected,p_requirement_id,p_hidden,p_version)::text);
  select * into prior from manufacturing.write_requests where request_id=p_request_id;
  if found then
    if prior.payload_hash <> fingerprint then raise sqlstate 'PT409' using message='Request ID reused with different payload'; end if;
    return prior.result;
  end if;
  if p_expected is distinct from md5(manufacturing.write_snapshot()::text) then
    raise sqlstate 'PT409' using message='Manufacturing state changed';
  end if;
  select to_jsonb(r) into before_row from manufacturing.requirements r where id=p_requirement_id;
  if before_row is null or (before_row->>'visibility_version')::bigint <> p_version then
    raise sqlstate 'PT409' using message='Visibility changed. Refresh before trying again.';
  end if;
  if p_hidden and not (before_row->>'obsolete')::boolean then
    raise sqlstate 'PT409' using message='Only obsolete requirements can be hidden';
  end if;
  if (before_row->>'hidden')::boolean = p_hidden then
    raise sqlstate 'PT409' using message='This requirement already has that visibility state';
  end if;
  result := jsonb_build_object('requirementId',p_requirement_id,'hidden',p_hidden,'visibilityVersion',p_version+1);
  insert into manufacturing.write_requests(request_id,actor,action,payload_hash,result)
    values(p_request_id,p_actor,'requirement_visibility',fingerprint,result);
  update manufacturing.requirements r set hidden=p_hidden, visibility_version=p_version+1,
    visibility_changed_at=clock_timestamp(), visibility_changed_by=coalesce(actor_name,p_actor::text),
    updated_at=clock_timestamp()
    where id=p_requirement_id returning to_jsonb(r) into after_row;
  insert into manufacturing.write_history(request_id,entity,row_id,before_row,after_row)
    values(p_request_id,'requirements',p_requirement_id,before_row,after_row);
  return result;
end;
$$;
revoke all on function public.manufacturing_set_requirement_hidden(uuid,uuid,text,bigint,boolean,bigint)
  from public, anon, authenticated;
grant execute on function public.manufacturing_set_requirement_hidden(uuid,uuid,text,bigint,boolean,bigint) to service_role;


commit;
