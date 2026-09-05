# FRC 190 Manufacturing OS

Supabase is the application's only manufacturing backend. Reads come from the
normalized manufacturing schema; claims, progress, completion/undo, CAM
handoffs, finishing, profile allocation renames, and QC use one atomic
transaction RPC with stale-write protection and audit history. PDFs and STEP
files are served from private Supabase Storage, and their exact original names
come from the private attachment catalog.

Passed QC batches can also carry one optional shop-wide storage location. The
current location is shown in Admin, Operations, Production, and Finishing and
can be changed or cleared by any approved machinist or administrator.

The historical [migration report](docs/baserow-supabase-staged-migration.md) and
[shadow validation report](docs/supabase-shadow-migration.md) remain as offline
cutover records. Onshape/BOM synchronization is maintained separately from this
application.

## To-Do List

- [X] Allow stealing of production tasks
- [ ] Cover edge cases such as: QC -> Finishing -> Tapping
- [X] Show material in production requirement
- [ ] Add stock size 
- [X] Filter by assembly

## Stack

- Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui
- AG Grid Community for editable shop-floor tables
- TanStack Query for cached data and optimistic mutations
- Supabase Auth for email and password sign-in
- Next.js Route Handlers as the server-only manufacturing data gateway
- Vercel deployment

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add the Supabase project URL, publishable key, and server-only secret key.
3. Run the SQL files in `supabase/migrations` in filename order, followed by the
   production manufacturing and attachment SQL documented in the
   [production-write runbook](docs/supabase-production-writes.md).
4. Enable `manufacturing.write_control` only after the production schema is ready.
5. Set `INITIAL_ADMIN_EMAILS` to one or more comma-separated administrator emails. These accounts bootstrap user approval and role assignment.
6. Enable email/password auth, with `/auth/callback` as an allowed redirect path for email confirmation and password recovery.
7. Add `/auth/callback` and `/auth/callback?next=/reset-password` to the Supabase redirect allow list for each app origin.
8. To deliver notification emails, create a Resend API key, verify the sender domain, and set `RESEND_API_KEY` plus `NOTIFICATION_EMAIL_FROM`.
9. Run `npm run dev`.

Authentication is mandatory. Missing Supabase server credentials fail closed
instead of loading demo data or falling back to another backend.

## Manufacturing writes

Operation actions use the atomic Supabase transaction RPC and also set:

- `Started At` and the signed-in machinist when work begins.
- `Completed At` and the signed-in machinist when work is completed.
- The linked production requirement's `Status`, `Machinist`, and `QC Outcome` as work advances through machining and inspection.

Operations also include whole-number `Claimed Quantity` and `Completed Quantity` fields plus a long-text `Quantity Ledger`. For batches larger than one, machinists choose how many parts to claim or complete. Claims can be released, completions can be reopened before QC passes, and the success notification offers an immediate undo action.

When all remaining parts are already claimed by someone else, the claim action becomes **Steal production requirement**. A second warning confirmation transfers only claimed quantities; completed quantities keep their original attribution. Each displaced account receives a durable unread website alert and a matching email.

Supported statuses match the live schema: Planned, Ready, In Progress, Blocked, Needs Rework, and Complete.

### CAM prerequisites

Haas CNC and Shop Sabre CNC operations have a separate, claimable CAM task at
the same operation number. For example, a Haas OP2 is paired with `CAM for
OP2`; CAM may proceed while OP1 manufacturing is underway, but the Haas work
does not become ready until both prerequisites are complete. CAM is one task
regardless of part quantity and accepts an optional shared-drive program path
when it is completed. It does not enter manufacturing QC.

The Operations table stores `Work Type`, `CAM Program Path`, and `CAM Notes`.
Historical migration utilities are retained only under
`scripts/manufacturing-migration` for offline audit and recovery.

The Fabrication tab reads active rows from the Finishing table and joins their linked production requirements for part, assembly, status, and file details. A finishing job becomes claimable when its requirement reaches `Ready for Finishing`; claiming records the machinist on the Finishing row. Completing it advances the linked requirement to `Complete` unless the route contains a `Threaded Insert` operation, in which case finishing releases that operation and the requirement completes after the inserts are installed. Release and undo actions reverse those changes.

The shop UI treats the Onshape document name and assembly part number as separate identifiers. It reads the document name from a `Source Document` text field on Production Requirements (with `Onshape Document` supported as a compatibility alias) and displays values such as `A-26C-0001`. The linked `Assembly` value, such as `A-190B-26…`, remains available for internal requirement identity and is not presented as the source document.

## Access and quality control

- New email/password accounts enter a pending state.
- Registration and account settings collect a first name and last initial. Shop assignments use the normalized `FirstName L.` display name rather than an email identifier.
- Authentication and account approval are required in every environment.
- An approved administrator assigns either the `machinist` or `admin` role.
- Approval and role checks are repeated on protected server routes; hiding the Admin tab is not the security boundary.
- Production requirements enter the administrator QC queue after every active pre-QC manufacturing operation is complete. `Threaded Insert` is the sole post-QC exception: it remains planned until QC passes and, when required, powder-coat finishing completes. Passing records the requirement-level review; failing records the review and returns the final pre-QC operation to `Needs Rework`.
- Supabase is the authoritative QC history by production requirement. Historical operation IDs are retained only as migration provenance. QC and its workflow update commit together in Supabase.
- `supabase/migrations/202609050001_qc_storage_locations.sql` adds the nullable location and editor attribution columns. Apply it before deploying application code that reads locations, then apply `supabase/production/20260905_qc_storage_locations.sql` after the manufacturing write RPC.
- A location is optional when QC passes. Only the latest effective passed review can be edited; an undone pass or a review made stale by later manufacturing completion is treated as pending and exposes no location.
- Location edits replace the current value and record the editor and time. Clearing records who cleared it, while undoing the QC pass removes both the location and its attribution from that review.

## Notifications

The reusable notification service in `lib/notifications.ts` stores an in-site alert before attempting email delivery. Delivery state (`pending`, `sent`, `failed`, or `skipped`) and provider details remain attached to the notification so failed email delivery can be diagnosed or retried later. The dashboard presents unread alerts one at a time, subscribes to new alerts through Supabase Realtime, and marks each read only after it is acknowledged. The initial unread-alert request remains as a reconnect fallback.

`RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM` are server-only. Without both values, website alerts still work and email delivery is recorded as skipped.

## Vercel

Import this directory as a Vercel project, add the values from `.env.example`, and deploy. Set `NEXT_PUBLIC_APP_URL` to the production origin for canonical metadata. Do not add legacy backend tokens or manufacturing source-selection flags.
