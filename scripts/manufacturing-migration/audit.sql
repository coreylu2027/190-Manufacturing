-- Read-only fingerprints. No account secrets or production row contents leave SQL.
begin isolation level repeatable read read only;
select
  (select count(*) from auth.users) as auth_users,
  (select md5(coalesce(jsonb_agg(to_jsonb(u) order by id)::text, '[]')) from auth.users u) as auth_users_fingerprint,
  (select count(*) from storage.buckets) as storage_buckets,
  (select count(*) from storage.objects) as storage_objects,
  (select md5(coalesce(jsonb_agg(to_jsonb(b) order by id)::text, '[]')) from storage.buckets b) as storage_buckets_fingerprint,
  (select md5(coalesce(jsonb_agg(to_jsonb(o) order by id)::text, '[]')) from storage.objects o) as storage_objects_fingerprint,
  (select md5(coalesce(jsonb_agg(to_jsonb(c) order by table_name, ordinal_position)::text, '[]'))
    from information_schema.columns c where table_schema = 'public') as public_columns_fingerprint,
  (select md5(coalesce(jsonb_agg(to_jsonb(p) order by tablename, policyname)::text, '[]'))
    from pg_policies p where schemaname = 'public') as public_policies_fingerprint,
  (select md5(coalesce(jsonb_agg(to_jsonb(i) order by indexname)::text, '[]'))
    from pg_indexes i where schemaname = 'public') as public_indexes_fingerprint,
  (select md5(coalesce(jsonb_agg(to_jsonb(g) order by table_name, grantee, privilege_type)::text, '[]'))
    from information_schema.table_privileges g where table_schema = 'public') as public_grants_fingerprint,
  (select md5(coalesce(jsonb_agg(jsonb_build_object('name', c.relname, 'rls', c.relrowsecurity,
    'force_rls', c.relforcerowsecurity) order by c.relname)::text, '[]'))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public') as public_relations_fingerprint,
  (select md5(coalesce(jsonb_agg(pg_get_functiondef(p.oid) order by p.oid)::text, '[]'))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind <> 'a') as public_functions_fingerprint,
  (select md5(coalesce(jsonb_agg(pg_get_triggerdef(t.oid) order by t.oid)::text, '[]'))
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'auth')) as existing_triggers_fingerprint;
commit;
