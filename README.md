# FRC 190 Manufacturing OS

The Baserow-to-Supabase migration has been **staged and validated without a live
cutover**. See [the migration report and runbook](docs/baserow-supabase-staged-migration.md)
for the copied tables, preservation checks, exclusions, and remaining cutover gates.
The [normalized candidate and shadow validation report](docs/supabase-shadow-migration.md)
records the independent backup, captured Onshape source, normalized import, and clean read parity.

Shop-floor workflow for the `V3-26 FRC190 Summer 2026` Baserow database. Onshape/BOM sync creates production requirements and routed operations; machinists use this app to filter available work, claim an operation, and record progress and completion.

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
- Next.js Route Handlers as the server-only Baserow proxy
- Vercel deployment

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add a Baserow database token with access to tables `1169282` (Operations), `1119642` (Production Requirements), and `1170619` (Finishing).
3. Add the Supabase project URL, public anonymous key, and server-only service role key.
4. Run the SQL files in `supabase/migrations` in filename order in the Supabase SQL editor.
5. Set `INITIAL_ADMIN_EMAILS` to one or more comma-separated administrator emails. These accounts bootstrap user approval and role assignment.
6. Enable email/password auth, with `/auth/callback` as an allowed redirect path for email confirmation and password recovery.
7. Add `/auth/callback` and `/auth/callback?next=/reset-password` to the Supabase redirect allow list for each app origin.
8. Set `REQUIRE_AUTH=true` after Supabase is configured.
9. To deliver notification emails, create a Resend API key, verify the sender domain, and set `RESEND_API_KEY` plus `NOTIFICATION_EMAIL_FROM`.
10. Run `npm run dev`.

Without a Baserow token, the app intentionally loads realistic demo rows so the full workflow can be reviewed safely. All production credentials remain server-only.

## Baserow writes

Operation actions update the Baserow Operations table and also set:

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
Run `npm run cam:migrate` to preview the Baserow-only reconciliation. The
initial destructive reset requires the explicit `--apply --reset-all` flags.
The command does not call Onshape APIs.

The Fabrication tab reads active rows from the Finishing table and joins their linked production requirements for part, assembly, status, and file details. A finishing job becomes claimable when its requirement reaches `Ready for Finishing`; claiming records the machinist on the Finishing row, and completing it advances the linked requirement to `Complete`. Release and undo actions reverse those changes.

The shop UI treats the Onshape document name and assembly part number as separate identifiers. It reads the document name from a `Source Document` text field on Production Requirements (with `Onshape Document` supported as a compatibility alias) and displays values such as `A-26C-0001`. The linked `Assembly` value, such as `A-190B-26…`, remains available for internal requirement identity and is not presented as the source document.

## Access and quality control

- New email/password accounts enter a pending state.
- Registration and account settings collect a first name and last initial. Shop assignments use the normalized `FirstName L.` display name rather than an email identifier.
- Any environment connected to live Baserow data requires authentication automatically; demo identities are available only when no Baserow token is configured.
- An approved administrator assigns either the `machinist` or `admin` role.
- Approval and role checks are repeated on protected server routes; hiding the Admin tab is not the security boundary.
- Production requirements enter the administrator QC queue only after every active manufacturing operation is complete. Passing records the requirement-level review; failing records the review and returns the final operation to `Needs Rework`.
- Supabase is the authoritative QC history by production requirement. Historical operation IDs are retained only as migration provenance. The latest QC notes, reviewer, review time, outcome, and workflow status are mirrored onto the Baserow Production Requirement for shop-floor visibility.
- When upgrading an existing Supabase project, apply the migrations first and run `npm run qc:migrate -- --apply` once to backfill existing operation-level reviews without deleting them.
- After adding the `QC Notes`, `QC Reviewed By`, and `QC Reviewed At` fields to Baserow, run `npm run qc:sync-baserow -- --apply` once to mirror existing reviews. New reviews are mirrored automatically.

## Notifications

The reusable notification service in `lib/notifications.ts` stores an in-site alert before attempting email delivery. Delivery state (`pending`, `sent`, `failed`, or `skipped`) and provider details remain attached to the notification so failed email delivery can be diagnosed or retried later. The dashboard presents unread alerts one at a time, subscribes to new alerts through Supabase Realtime, and marks each read only after it is acknowledged. The initial unread-alert request remains as a reconnect fallback.

`RESEND_API_KEY` and `NOTIFICATION_EMAIL_FROM` are server-only. Without both values, website alerts still work and email delivery is recorded as skipped.

## Vercel

Import this directory as a Vercel project, add the values from `.env.example`, and deploy. Set `NEXT_PUBLIC_APP_URL` to the production origin for canonical metadata.
