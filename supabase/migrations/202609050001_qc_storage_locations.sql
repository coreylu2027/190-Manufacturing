alter table public.quality_control
  add column storage_location text,
  add column location_updated_by uuid references auth.users(id) on delete restrict,
  add column location_updated_at timestamptz,
  add constraint quality_control_storage_location_check check (storage_location is null or storage_location in (
    'Clarke 1','Clarke 2','Clarke 3','Clarke 4','Clarke 5','Clarke 6','Clarke 7','Clarke 8',
    'Kwolek 1-1','Kwolek 1-2','Kwolek 1-3','Kwolek 1-4','Kwolek 1-5','Kwolek 1-6','Kwolek 1-7','Kwolek 1-8',
    'Kwolek 2-1','Kwolek 2-2','Kwolek 2-3','Kwolek 2-4','Kwolek 2-5','Kwolek 2-6','Kwolek 2-7','Kwolek 2-8',
    'Hopper 1','Hopper 2','Hopper 3','Hopper 4','Hopper 5','Hopper 6','Hopper 7','Hopper 8',
    'Jemison 1-1','Jemison 1-2','Jemison 1-3','Jemison 1-4','Jemison 1-5','Jemison 1-6','Jemison 1-7','Jemison 1-8',
    'Jemison 2-1','Jemison 2-2','Jemison 2-3','Jemison 2-4','Jemison 2-5','Jemison 2-6','Jemison 2-7','Jemison 2-8',
    'Shelf 1','Shelf 2','Shelf 3'
  )),
  add constraint quality_control_location_attribution_check check (
    (location_updated_by is null) = (location_updated_at is null)
    and (storage_location is null or location_updated_by is not null)
  );
