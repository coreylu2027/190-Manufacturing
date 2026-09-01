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
3. Add the Supabase project URL and public anonymous key.
4. Enable Google and Azure providers in Supabase, with `/auth/callback` as an allowed redirect path.
5. Set `REQUIRE_AUTH=true` after Supabase is configured.
6. Run `npm run dev`.

Without a Baserow token, the app intentionally loads realistic demo rows so the full workflow can be reviewed safely. All production credentials remain server-only.

## Baserow writes

The editable `Status` and `Machinist` cells update the Operations table. Quick actions also set:

- `Started At` and the signed-in machinist when work begins.
- `Completed At` and the signed-in machinist when work is completed.

Supported statuses match the live schema: Planned, Ready, In Progress, Blocked, Needs Rework, and Complete.

## Vercel

Import this directory as a Vercel project, add the values from `.env.example`, and deploy. Set `NEXT_PUBLIC_APP_URL` to the production origin for canonical metadata.
