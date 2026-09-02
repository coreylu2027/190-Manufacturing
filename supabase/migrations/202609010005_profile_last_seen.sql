alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create policy "Users can update their own last seen timestamp"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

grant update (last_seen_at) on table public.profiles to authenticated;
