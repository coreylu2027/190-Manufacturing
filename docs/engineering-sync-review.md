# Staged Onshape sync review

The Poot Horse sync no longer writes straight into the shop. It stages what it
would commit, and an approved administrator reviews it in **Admin → Onshape sync
review** (`/admin/sync`), then approves it, approves it with changes skipped, or
denies it.

## Flow

1. The workflow runs `integrations/onshape/OnshapeToSupabase.py` with
   `STAGE_FOR_REVIEW=true`. It resolves Onshape, exports and uploads changed
   drawings and STEP files to private Storage (content-addressed, never
   overwriting), then calls `manufacturing_stage_engineering_sync`.
2. The payload is stored in `manufacturing.engineering_sync_proposals` and the
   run becomes `staged`. Every approved admin gets an in-app alert (and email,
   if the notifications webhook is configured) with a **Review now** link. A
   newer staged sync replaces any proposal still waiting.
3. The review page diffs the payload against current rows, using the same scope
   and matching rules as the engineering RPC:
   - **New** and **Removed** requirements, and **New revision** when a part's
     required revision changes (old requirement retired, new one created);
   - **Changed** quantity, routing, finishing, or source document;
   - **Back in BOM** for a previously removed requirement that returns;
   - **Part details** (name, description, material, method, vendor, category,
     COTS) and **Files** (new drawing PDFs and STEP files);
   - **Main membership** flags, in Main-discovery mode.

   Each item shows recorded shop work it touches (claims, completed counts, QC,
   On Robot) and predicts obsoletion and stop-work alerts. Values are compared
   with what Onshape last delivered, and active shop corrections are called out.
   Link, BOM-position, and revision-marker updates are counted, not listed.
4. **Approve** commits the included changes through the unchanged
   `manufacturing_apply_engineering_sync` inside
   `manufacturing_decide_engineering_sync`. Admin corrections, routing
   initialization, obsoletion, and stop-work alerts run exactly as they do for a
   direct sync. **Deny** commits nothing.

## Skipping changes

Uncheck a root, a change, or a single field before approving.

| Skipped | What the shop keeps |
| --- | --- |
| Root | Everything under it, including its revision marker, so the next run proposes it again |
| New requirement | Not created |
| Removed requirement | Stays active with its current values |
| New revision | The current revision stays active; the new one isn't created |
| Changed field | The current value |
| Part field | The current value |
| Files | The current files |

Skipped items are re-sent with the values Onshape last delivered, so shop
corrections neither retire nor move. Except for a skipped root, the root's
revision marker still advances, so skipped changes aren't proposed again until
the next Onshape release (or a `force_refresh` run). A skipped change is a
one-time decision; to make a value stick across releases, use **Correct Onshape
data** after approving, which the corrections report tracks for the CAD team.

Requirements whose keys predate revision-stable identity can't be kept, and
their removal can't be skipped.

## Safety

- The review is fingerprinted. If the proposal or relevant shop rows change
  while an admin reviews, approval returns 409 and the page reloads.
- If any other sync commits after a proposal's run started, the proposal is
  marked stale and can't be approved; run the sync again.
- If the commit fails, it rolls back completely, the proposal shows the error,
  and it can be retried or denied.
- Warnings make the commit partial, which deactivates removed requirements but
  doesn't mark them obsolete. The page says so up front.
- A staged run isn't `running`, so shop edits while a proposal waits aren't
  mistaken for sync changes.
- All four RPCs are `security definer` with an empty search path, executable
  only by `service_role`. Deciding requires an approved `admin` profile, checked
  in the app and again in the database.
- Payloads are cleared 30 days after a decision; the reviewed change list and
  result stay.

## Installation

1. Apply `supabase/migrations/20260929120000_engineering_sync_review.sql` after
   the engineering-sync API, routing initialization, obsoletion, admin
   overrides, and notifications migrations. It adds run states, the proposals
   table, and four RPCs; it changes no existing rows.
2. Deploy the app.
3. Add the repository secrets and variable below.
4. Merge to `main`: manual runs only commit from the default branch.
5. In `Team-190/.github`, disable or delete `onshape_supabase_poot_horse.yml`,
   which still commits directly. Point any `bom_sync_poot_horse_supabase`
   `repository_dispatch` sender at this repository.

### GitHub Actions secrets

| Secret | Value |
| --- | --- |
| `ONSHAPE_ACCESS_KEY` | Onshape API access key (same as `Team-190/.github`) |
| `ONSHAPE_SECRET_KEY` | Onshape API secret key |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Supabase secret key (`sb_secret_…`) or legacy service-role key |
| `ONSHAPE_DOC_URL_EPSILON` | Main-workspace assembly URL. Needed only for Main discovery (`use_subassembly_list=false`) or dry runs with it |

Optional repository **variable** `MANUFACTURING_APP_URL` (the app origin, for
example `https://manufacturing.example.com`) adds a review link to the job
summary.

## Verification

- `npm run onshape:test` — sync CLI, including staging (mocked APIs).
- `npm run onshape:test-sql` — PGlite: the engineering RPC and its contract, and
  the staged-review flow end to end (staging, alerts, review, approval with
  skips, obsoletion, routing initialization, supersession, stale proposals,
  failed commits, denial, and permissions).
- `npm test` — review and payload-building rules.
