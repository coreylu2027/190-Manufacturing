# Part history and source document progress

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

## Progress by source document

The Production page's **Progress by source document** panel groups active
requirements by the document they were **synced from** and shows each status as
a share of a bar. The percentage counts complete parts out of those the shop
makes: off-the-shelf parts are shown but not counted, and obsolete requirements
are excluded. Hidden requirements follow the page's **Show hidden** setting.
Selecting a document filters the parts list, as does the **Synced from** filter.

"Synced from" differs from a part's source document for imported subassemblies.
A configurable roller's parts report the Configurable Roller document, but they
were synced through a root assembly such as A-190B-261131 in A-26C-0004. The
sync records only the root assembly (`source_root`), so the projection takes
the root's document to be the most common source document among the root
assembly's own direct parts, preferring active ones. The parts list shows it in
a **Synced from** column, and the detail panels show it beside the source root.

## Installation

Apply `supabase/migrations/20260923170000_requirement_history.sql`. It adds one
read-only function and an index on `write_history(entity, row_id)`; it does not
change any rows.

## Verification

- `npm test` includes `lib/requirement-history.test.mts` and
  `lib/document-progress.test.mts`.
- `npm run manufacturing:test-overrides` checks the SQL function in PGlite: scope
  to one requirement, part-level corrections, QC reviews, and permissions.
