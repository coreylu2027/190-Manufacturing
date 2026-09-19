begin;

-- One durable inbox/email item per recipient and transition, even if several
-- operations are claimed. Existing notification RLS and realtime apply.
create unique index notifications_obsolete_transition_idx
  on public.notifications(recipient_id, (data->>'requirementId'), (data->>'obsoletionVersion'))
  where type='production_requirement_obsolete';

create function manufacturing.notify_obsolete_work() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  op record;
  allocation jsonb;
  ledger jsonb;
  recipient uuid;
  matched integer;
  recipients uuid[] := '{}';
  part_label text;
  operation_labels text;
begin
  if not new.obsolete or old.obsolete then return new; end if;
  select concat_ws(' — ',p.part_number,p.name) into part_label
    from manufacturing.parts p where p.id=new.part_id;
  -- Sync deactivates old routing before obsoletion. Include those retained
  -- claims as well as active routing; never transfer or release allocations.
  for op in select * from manufacturing.operations where requirement_id=new.id loop
    begin
      ledger := coalesce(nullif(op.quantity_ledger,''),'[]')::jsonb;
    exception when invalid_text_representation then ledger := '[]'::jsonb;
    end;
    if jsonb_typeof(ledger) is distinct from 'array' then ledger := '[]'::jsonb; end if;
    if jsonb_array_length(ledger)=0 and
       (coalesce(op.claimed_quantity,0)>0 or (op.claimed_quantity is null and op.status='In Progress')) then
      ledger := jsonb_build_array(jsonb_build_object('userId','legacy:', 'name',op.machinist,'claimed',1));
    end if;
    for allocation in select value from jsonb_array_elements(ledger) loop
      if jsonb_typeof(allocation->'claimed') is distinct from 'number' then continue; end if;
      if (allocation->>'claimed')::numeric<=0 then continue; end if;
      recipient := null;
      if coalesce(allocation->>'userId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        select id into recipient from public.profiles where id=(allocation->>'userId')::uuid;
      elsif coalesce(allocation->>'userId','') like 'legacy:%' then
        -- Never guess between people with the same legacy display name.
        select count(*), (array_agg(id))[1] into matched,recipient from public.profiles
          where lower(btrim(display_name))=lower(btrim(allocation->>'name'));
        if matched<>1 then recipient := null; end if;
      end if;
      if recipient is not null and not recipient=any(recipients) then
        recipients := array_append(recipients,recipient);
      end if;
    end loop;
  end loop;
  select string_agg(distinct concat_ws(' ',work_type,operation_number),', ')
    into operation_labels from manufacturing.operations where requirement_id=new.id;
  foreach recipient in array recipients loop
    insert into public.notifications(recipient_id,type,title,message,data)
    values(recipient,'production_requirement_obsolete','Stop work: your part is obsolete',
      format('%s (revision %s, requirement #%s) was marked obsolete by %s. You have claimed work on this requirement. Stop work. Do not manufacture or install this part. Your claims and completed work remain recorded.%s',
        part_label,coalesce(nullif(new.required_part_revision,''),'unspecified'),new.id,
        coalesce(new.obsoletion_changed_by,'Engineering sync'),
        case when new.part_location='On Robot' then ' This part is recorded as On Robot; review its installation.' else '' end),
      jsonb_build_object('requirementId',new.id,'obsoletionVersion',new.obsoletion_version,
        'origin',new.obsoletion_origin,'replacementRequirementId',new.obsolete_replacement_id,
        'operationLabels',operation_labels,'revision',new.required_part_revision))
    on conflict do nothing;
  end loop;
  return new;
end;
$$;
revoke all on function manufacturing.notify_obsolete_work() from public,anon,authenticated,service_role;
create trigger notify_obsolete_work after update of obsolete on manufacturing.requirements
  for each row when(new.obsolete and not old.obsolete)
  execute function manufacturing.notify_obsolete_work();
commit;
