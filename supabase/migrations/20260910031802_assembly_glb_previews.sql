-- Assembly previews are additive fallbacks. Existing STEP previews are never mutated.
begin;
create table manufacturing.assembly_part_previews (
  part_id bigint primary key references manufacturing.parts(id) on delete restrict,
  source_name text not null check (source_name <> ''),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_mesh_index integer not null check (source_mesh_index >= 0),
  matched_name text not null check (matched_name <> ''),
  generator_version text not null default '1',
  byte_size bigint not null check (byte_size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_bucket text not null check (storage_bucket = 'manufacturing-files'),
  storage_path text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  check (storage_path = 'sha256/' || left(sha256, 2) || '/' || sha256 || '.glb')
);
alter table manufacturing.assembly_part_previews enable row level security;
revoke all on manufacturing.assembly_part_previews from public, anon, authenticated, service_role;

-- Match the application's existing server-only RPC boundary into the private schema.
-- Only the server service role receives EXECUTE; browser roles cannot call these.
create function public.manufacturing_assembly_preview_inventory()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'part_number', p.part_number, 'name', p.name,
    'has_preview', exists(select 1 from manufacturing.part_previews v where v.part_id = p.id)
       or exists(select 1 from manufacturing.assembly_part_previews v where v.part_id = p.id)
  ) order by p.id), '[]'::jsonb) from manufacturing.parts p;
$$;
revoke all on function public.manufacturing_assembly_preview_inventory() from public, anon, authenticated;
grant execute on function public.manufacturing_assembly_preview_inventory() to service_role;

create function public.manufacturing_register_assembly_preview(
  p_part_id bigint, p_matched_name text, p_source_name text, p_source_sha256 text,
  p_source_mesh_index integer, p_byte_size bigint, p_sha256 text, p_verified_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from manufacturing.parts where id = p_part_id and name = p_matched_name for update;
  if not found then raise exception 'Part identity changed or missing'; end if;
  if exists(select 1 from manufacturing.part_previews where part_id = p_part_id)
     or exists(select 1 from manufacturing.assembly_part_previews where part_id = p_part_id) then
    return false;
  end if;
  insert into manufacturing.assembly_part_previews (
    part_id, matched_name, source_name, source_sha256, source_mesh_index,
    byte_size, sha256, storage_bucket, storage_path, verified_at
  ) values (
    p_part_id, p_matched_name, p_source_name, p_source_sha256, p_source_mesh_index,
    p_byte_size, p_sha256, 'manufacturing-files',
    'sha256/' || left(p_sha256, 2) || '/' || p_sha256 || '.glb', p_verified_at
  ) on conflict (part_id) do nothing;
  return found;
end;
$$;
revoke all on function public.manufacturing_register_assembly_preview(bigint,text,text,text,integer,bigint,text,timestamptz) from public, anon, authenticated;
grant execute on function public.manufacturing_register_assembly_preview(bigint,text,text,text,integer,bigint,text,timestamptz) to service_role;

create or replace function public.manufacturing_preview_for_requirement(p_requirement_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with selected_step as (
    select a.* from manufacturing.requirements r
    join manufacturing.attachments a on a.part_id = r.part_id
    where r.id = p_requirement_id and a.kind = 'step'
    order by a.position, a.id limit 1
  ), candidates as (
    select 0 as priority, p.storage_bucket, p.storage_path, p.content_type,
      p.byte_size, p.sha256, p.source_sha256
    from selected_step a join manufacturing.part_previews p
      on p.source_attachment_id = a.id and p.source_sha256 = a.sha256
    union all
    select 1, p.storage_bucket, p.storage_path, 'model/gltf-binary',
      p.byte_size, p.sha256, p.source_sha256
    from manufacturing.requirements r
    join manufacturing.assembly_part_previews p on p.part_id = r.part_id
    where r.id = p_requirement_id
      and not exists(select 1 from manufacturing.part_previews existing where existing.part_id = r.part_id)
  )
  select jsonb_build_object('bucket', storage_bucket, 'path', storage_path,
    'content_type', content_type, 'byte_size', byte_size, 'sha256', sha256, 'source_sha256', source_sha256)
  from candidates order by priority limit 1;
$$;
revoke all on function public.manufacturing_preview_for_requirement(bigint) from public, anon, authenticated;
grant execute on function public.manufacturing_preview_for_requirement(bigint) to service_role;
commit;
