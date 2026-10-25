-- Supabase's default privileges can give anon and authenticated full access to
-- new tables in public, leaving RLS as the only guard. The update policies on
-- profiles and notifications choose rows, not columns, so a table-level UPDATE
-- grant would let a user approve themselves, make themselves an administrator,
-- or take another shop name. Grant back only what the browser client uses.
revoke all on table public.profiles, public.notifications, public.quality_control from anon, authenticated;
revoke all on sequence public.quality_control_id_seq from anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (last_seen_at) on table public.profiles to authenticated;

grant select on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

-- A revoke by a role without grant authority only warns, so confirm it took effect.
do $$
begin
  if has_column_privilege('authenticated', 'public.profiles', 'approved', 'UPDATE')
    or has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
    or has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE')
    or has_table_privilege('anon', 'public.profiles', 'SELECT')
    or has_table_privilege('authenticated', 'public.quality_control', 'SELECT')
    or has_column_privilege('authenticated', 'public.notifications', 'title', 'UPDATE') then
    raise exception 'public table privileges are still open to anon or authenticated';
  end if;
end $$;
