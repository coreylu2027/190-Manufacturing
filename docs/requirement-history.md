# Part history

## History

Each Production and Operations detail panel has a **History** timeline for the
production requirement, newest first. It combines:

- every recorded shop write that touched the requirement, its operations, or its
  finishing job (claims, completions, releases, steals, CAM handoffs, locations,
  notes, obsoletion, visibility), from `manufacturing.write_history`;
- part-level Onshape corrections (name, material, files), which apply to every
  requirement for the part;
- QC reviews from `public.quality_control`, merged with the write that recorded
  them and marked when later undone; and
- correction events, including corrections the Onshape sync retired.

Writes made before the move to Supabase and the Onshape sync's own updates are
not in `write_history`, so they don't appear. Readiness re-planning (Planned →
Ready) is left out as noise; direct status edits and requirement status changes
are shown.

`public.manufacturing_requirement_history(requirement_id)` returns the raw rows
(service role only, latest 200 writes); `lib/requirement-history.ts` formats
them, and `GET /api/requirements/[id]/history` serves them to approved users.
The timeline refreshes with the rest of the manufacturing data after each write.

## Installation

Apply `supabase/migrations/20260923170000_requirement_history.sql`. It adds one
read-only function and an index on `write_history(entity, row_id)`; it does not
change any rows.

## Verification

- `npm test` includes `lib/requirement-history.test.mts`.
- `npm run manufacturing:test-overrides` checks the SQL function in PGlite: scope
  to one requirement, part-level corrections, QC reviews, and permissions.
