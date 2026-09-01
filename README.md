# FRC 190 Manufacturing OS

Shop-floor workflow for the `V3-26 FRC190 Summer 2026` Baserow database. Onshape/BOM sync creates production requirements and routed operations; machinists use this app to filter available work, claim an operation, and record progress and completion.

## Stack

- Next.js, React, TypeScript, Tailwind CSS, and shadcn/ui
- AG Grid Community for editable shop-floor tables
- TanStack Query for cached data and optimistic mutations
- Supabase Auth for Google and Microsoft sign-in
- Next.js Route Handlers as the server-only Baserow proxy
- Vercel deployment

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add a Baserow database token with access to tables `1169282` (Operations) and `1119642` (Production Requirements).
3. Add the Supabase project URL, public anonymous key, and server-only service role key.
4. Run `supabase/migrations/202609010001_admin_approval_and_qc.sql` in the Supabase SQL editor.
5. Set `INITIAL_ADMIN_EMAILS` to one or more comma-separated administrator emails. These accounts bootstrap user approval and role assignment.
6. Enable email/password auth. Google and Azure may remain enabled, with `/auth/callback` as an allowed redirect path.
7. Add `/auth/callback` and `/auth/callback?next=/reset-password` to the Supabase redirect allow list for each app origin.
8. Set `REQUIRE_AUTH=true` after Supabase is configured.
9. Run `npm run dev`.

Without a Baserow token, the app intentionally loads realistic demo rows so the full workflow can be reviewed safely. All production credentials remain server-only.

## Baserow writes

Operation actions update the Baserow Operations table and also set:

- `Started At` and the signed-in machinist when work begins.
- `Completed At` and the signed-in machinist when work is completed.
- The linked production requirement's `Status`, `Machinist`, and `QC Outcome` as work advances through machining and inspection.

Operations also include whole-number `Claimed Quantity` and `Completed Quantity` fields plus a long-text `Quantity Ledger`. For batches larger than one, machinists choose how many parts to claim or complete. Claims can be released, completions can be reopened before QC passes, and the success notification offers an immediate undo action.

Supported statuses match the live schema: Planned, Ready, In Progress, Blocked, Needs Rework, and Complete.

## Access and quality control

- New email/password and OAuth accounts enter a pending state.
- Registration and account settings collect a first name and last initial. Shop assignments use the normalized `FirstName L.` display name rather than an email identifier.
- Any environment connected to live Baserow data requires authentication automatically; demo identities are available only when no Baserow token is configured.
- An approved administrator assigns either the `machinist` or `admin` role.
- Approval and role checks are repeated on protected server routes; hiding the Admin tab is not the security boundary.
- Completed operations enter the administrator QC queue. Passing records the review; failing records the review and returns the operation to `Needs Rework`.
- QC notes and reviewer details are stored in Supabase. The operation status and linked production requirement's QC outcome remain stored in Baserow.

## Vercel

Import this directory as a Vercel project, add the values from `.env.example`, and deploy. Set `NEXT_PUBLIC_APP_URL` to the production origin for canonical metadata.
