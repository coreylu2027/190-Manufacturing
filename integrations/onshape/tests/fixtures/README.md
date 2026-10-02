These three files are exact, unmodified contract fixtures from
`coreylu2027/190-Manufacturing`, branch `experimental`, commit
`b915b1439ae4fed616f24935de552734ebea525b`:

- `contract-normalized.sql`: `supabase/production/20260905_normalized_manufacturing.sql`
- `contract-attachments.sql`: `supabase/production/20260905_manufacturing_attachments.sql`
- `contract-model.ts`: `lib/manufacturing/model.ts`

The local PostgreSQL test loads the schema and attachment fixtures before the
new migration, and extracts shop-owned fields from the model for preservation
and rejection tests. Legacy source identifiers in these fixtures are required
by the authoritative contract; they are not integration configuration.

The test supplies minimal local staging and Storage tables. It never starts
Supabase or contacts a backend. Storage HTTP behavior is covered separately
with Python mocks.
