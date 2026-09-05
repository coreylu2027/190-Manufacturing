alter table public.quality_control
  add constraint quality_control_operation_id_key unique (operation_id);

grant usage, select on sequence public.quality_control_id_seq to service_role;
