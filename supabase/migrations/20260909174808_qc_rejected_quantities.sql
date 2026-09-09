alter table public.quality_control
  add column if not exists rejected_quantity integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'quality_control_rejected_quantity_positive'
      and conrelid = 'public.quality_control'::regclass
  ) then
    alter table public.quality_control
      add constraint quality_control_rejected_quantity_positive
      check (rejected_quantity is null or rejected_quantity > 0);
  end if;
end;
$$;
