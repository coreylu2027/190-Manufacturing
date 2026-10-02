"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Ban, CircleCheck, CircleX, ExternalLink, GitCompareArrows, Info, LoaderCircle, Search, TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeSyncResult, SYNC_CHANGE_LABELS, syncChangeCounts,
  type StoredSyncReview, type SyncChange, type SyncChangeKind, type SyncProposalStatus, type SyncProposalSummary, type SyncReview,
} from "@/lib/engineering-sync-review";
import { cn } from "@/lib/utils";

type ProposalDetail = SyncProposalSummary & { exclusions: string[]; review: StoredSyncReview | null };
interface ProposalResponse { proposal: ProposalDetail; stale: boolean; review: SyncReview | null }
type KindFilter = "all" | SyncChangeKind;

const INITIAL_ROWS = 150;
const STATUS_LABELS: Record<SyncProposalStatus, string> = {
  pending: "Waiting for review", approved: "Approved", denied: "Denied", superseded: "Superseded", failed: "Approval rolled back",
};
const STATUS_TONES: Record<SyncProposalStatus, string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200",
  denied: "border-border bg-muted text-muted-foreground",
  superseded: "border-border bg-muted text-muted-foreground",
  failed: "border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-200",
};
const KIND_TONES: Record<SyncChangeKind, string> = {
  removed: "border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-200",
  revised: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-400/30 dark:bg-violet-400/15 dark:text-violet-200",
  changed: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-400/30 dark:bg-blue-400/15 dark:text-blue-200",
  restored: "border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-400/30 dark:bg-teal-400/15 dark:text-teal-200",
  added: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-200",
  part: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-400/30 dark:bg-sky-400/15 dark:text-sky-200",
  files: "border-border bg-muted text-foreground",
  membership: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200",
};
const SKIPPED_MEANING: Record<SyncChangeKind, string> = {
  added: "Skipped: not added.",
  restored: "Skipped: stays out of the BOM.",
  removed: "Skipped: stays active with its current values.",
  revised: "Skipped: the shop keeps the current revision; the new one isn't created.",
  changed: "Skipped: keeps the current values.",
  part: "Skipped: keeps the current part details.",
  files: "Skipped: keeps the current files.",
  membership: "",
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? fallback);
  return body as T;
}
const fetchProposals = async () => (await readJson<{ proposals: SyncProposalSummary[] }>(
  await fetch("/api/admin/engineering-sync", { cache: "no-store" }), "Unable to load Onshape syncs")).proposals;
const fetchProposal = async (id: string) => readJson<ProposalResponse>(
  await fetch(`/api/admin/engineering-sync/${id}`, { cache: "no-store" }), "Unable to load the sync");

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
function proposalTitle(proposal: SyncProposalSummary) {
  return `${proposal.details.label || "Onshape"} sync`;
}
function proposalRoots(proposal: SyncProposalSummary) {
  const roots = proposal.summary.synced_roots ?? [];
  return roots.length ? roots.join(", ") : "Main membership only";
}

function StatusBadge({ status }: { status: SyncProposalStatus }) {
  return <Badge variant="outline" className={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

/** Compact status for the top of the Admin workspace. */
export function EngineeringSyncCard() {
  const query = useQuery({ queryKey: ["engineering-sync"], queryFn: fetchProposals });
  const pending = query.data?.filter((proposal) => proposal.status === "pending" || proposal.status === "failed") ?? [];
  const latest = query.data?.[0];
  return (
    <div className={cn("mb-6 flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-[0_14px_42px_rgba(15,23,42,.055)] sm:flex-row sm:items-center",
      pending.length > 0 && "border-amber-300 dark:border-amber-400/40")}>
      <div className={cn("grid size-10 shrink-0 place-items-center rounded-xl", pending.length ? "bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300" : "bg-muted text-muted-foreground")}>
        <GitCompareArrows className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">Onshape sync review</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {query.isPending ? "Checking for staged syncs…"
            : query.isError ? query.error.message
              : pending.length ? `${plural(pending.length, "sync")} waiting for review. Nothing changes in the shop until you approve.`
                : latest ? `Nothing waiting. Last sync: ${STATUS_LABELS[latest.status].toLowerCase()}${latest.decidedBy ? ` by ${latest.decidedBy}` : ""}, ${formatDate(latest.decidedAt ?? latest.stagedAt)}.`
                  : "No syncs have been staged yet. Run the Onshape sync workflow to stage one."}
        </p>
      </div>
      <Button variant={pending.length ? "default" : "outline"} nativeButton={false}
        render={<Link href={pending[0] ? `/admin/sync?proposal=${pending[0].id}` : "/admin/sync"} />}>
        {pending.length ? "Review changes" : "Sync history"}
      </Button>
    </div>
  );
}

export function EngineeringSyncReview() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const list = useQuery({ queryKey: ["engineering-sync"], queryFn: fetchProposals });
  const selectedId = searchParams.get("proposal") ?? list.data?.[0]?.id ?? null;

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5">
        <Link href="/admin" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"><ArrowLeft className="size-4" />Administrator workspace</Link>
        <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Onshape sync review</h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
          Each sync run stages what it would change. Review it, skip anything that shouldn’t reach the shop yet, then approve or deny it.
        </p>
      </div>
      <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
          <h2 className="border-b bg-muted/25 px-4 py-3 text-sm font-semibold">Recent syncs</h2>
          {list.isPending ? (
            <div className="space-y-2 p-3">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)}</div>
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{list.error.message}</p>
          ) : !list.data.length ? (
            <p className="p-4 text-sm text-muted-foreground">No syncs yet. Run “Sync Onshape poot_horse BOM” in GitHub Actions to stage one.</p>
          ) : (
            <ul className="max-h-[70vh] divide-y overflow-y-auto">
              {list.data.map((proposal) => (
                <li key={proposal.id}>
                  <button type="button" onClick={() => router.replace(`${pathname}?proposal=${proposal.id}`, { scroll: false })}
                    aria-current={proposal.id === selectedId ? "true" : undefined}
                    className={cn("w-full px-4 py-3 text-left transition-colors hover:bg-muted/60", proposal.id === selectedId && "bg-accent/60")}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold">{proposalTitle(proposal)}</span><StatusBadge status={proposal.status} /></div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={proposalRoots(proposal)}>{proposalRoots(proposal)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Staged {formatDate(proposal.stagedAt)}{proposal.decidedBy ? ` · ${proposal.decidedBy}` : ""}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        {selectedId ? <ProposalView key={selectedId} id={selectedId} />
          : !list.isPending && <div className="grid min-h-60 place-items-center rounded-2xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">Select a sync to review it.</div>}
      </div>
    </section>
  );
}

function Banner({ tone, icon: Icon, children }: { tone: "warning" | "danger" | "info"; icon: typeof Info; children: ReactNode }) {
  return (
    <div role={tone === "info" ? undefined : "alert"} className={cn("flex gap-2.5 rounded-xl border px-3.5 py-3 text-sm",
      tone === "danger" ? "border-red-200 bg-red-50 text-red-900 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100"
        : tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100"
          : "border-border bg-muted/40 text-foreground")}>
      <Icon className="mt-0.5 size-4 shrink-0" /><div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

function ProposalView({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["engineering-sync", id], queryFn: () => fetchProposal(id) });
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "deny" | null>(null);
  // The review the admin confirmed; a live refresh after that makes the server refuse.
  const [confirmedToken, setConfirmedToken] = useState("");
  const openConfirm = (decision: "approve" | "deny") => { setConfirmedToken(review?.token ?? ""); setConfirm(decision); };
  const review = query.data?.review ?? null;
  const proposal = query.data?.proposal;

  const validIds = useMemo(() => {
    const ids = new Set<string>();
    for (const root of review?.roots ?? []) ids.add(`root:${root.root}`);
    for (const change of review?.changes ?? []) { ids.add(change.id); for (const field of change.fields) ids.add(field.id); }
    return ids;
  }, [review]);
  const exclusions = [...excluded].filter((exclusionId) => validIds.has(exclusionId));
  const rootSkipped = (root: string | null) => Boolean(root && excluded.has(`root:${root}`));
  const applied = (change: SyncChange) => !excluded.has(change.id) && !rootSkipped(change.root);
  const reviewable = review?.changes.filter((change) => change.kind !== "membership") ?? [];
  const appliedCount = reviewable.filter(applied).length;
  const skippedFields = reviewable.filter(applied).flatMap((change) => change.fields).filter((field) => excluded.has(field.id)).length;
  const skippedSummary = [reviewable.length - appliedCount && plural(reviewable.length - appliedCount, "change"),
    skippedFields && plural(skippedFields, "field change")].filter(Boolean).join(" and ");
  const allRootsSkipped = Boolean(review?.roots.length) && review!.roots.every((root) => rootSkipped(root.root));
  const counts = syncChangeCounts(review?.changes ?? []);
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (review?.changes ?? []).filter((change) => (kind === "all" || change.kind === kind)
      && (!term || [change.title, change.context, change.summary, ...change.details, ...change.fields.map((field) => field.label)]
        .join(" ").toLocaleLowerCase().includes(term)));
  }, [kind, review, search]);

  const setApplied = (exclusionId: string, apply: boolean) => setExcluded((current) => {
    const next = new Set(current);
    if (apply) next.delete(exclusionId); else next.add(exclusionId);
    return next;
  });
  const mutation = useMutation({
    mutationFn: async (decision: "approve" | "deny") => readJson<{ status: string; proposal_status: SyncProposalStatus; error?: string }>(
      await fetch(`/api/admin/engineering-sync/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, exclusions, token: confirmedToken, note }),
      }), "Unable to record the decision"),
    onSuccess: (result) => {
      setConfirm(null);
      if (result.proposal_status === "failed") toast.error(`Approval rolled back: ${result.error ?? "unknown error"}. Nothing was committed.`);
      else if (result.proposal_status === "denied") toast.success("Sync denied. Nothing was committed.");
      else toast.success(result.status === "partial" ? "Sync approved and committed with warnings" : "Sync approved and committed");
    },
    onError: (error) => { setConfirm(null); toast.error(error.message); },
    onSettled: async () => {
      await Promise.all(["engineering-sync", "operations", "fabrication", "qc", "admin", "engineering-corrections"]
        .map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });

  if (query.isPending) return <div className="space-y-3 rounded-2xl border bg-card p-5">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}</div>;
  if (query.isError || !proposal) {
    return <div className="grid min-h-60 place-items-center rounded-2xl border bg-card p-6 text-center"><div><CircleX className="mx-auto mb-3 size-10 text-destructive" /><p className="font-semibold">Couldn’t load this sync</p><p className="mt-1 text-sm text-muted-foreground">{query.error?.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>;
  }
  const stale = query.data.stale;
  const decidable = proposal.status === "pending" || proposal.status === "failed";
  const busy = mutation.isPending;
  const revisions = proposal.details.source_revisions ?? [];

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
      <div className="space-y-4 border-b bg-muted/25 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-bold tracking-tight">{proposalTitle(proposal)}</h2><StatusBadge status={proposal.status} /></div>
            <p className="mt-1 text-sm text-muted-foreground">
              Staged {formatDate(proposal.stagedAt)}
              {proposal.details.roots_checked ? ` · ${plural(proposal.details.roots_checked, "root")} checked` : ""}
              {proposal.details.force_refresh ? " · forced refresh" : ""}
              {proposal.details.sync_cad_files === false ? " · CAD files not exported" : ""}
            </p>
          </div>
          {proposal.runUrl && <Button variant="outline" size="sm" nativeButton={false} render={<a href={proposal.runUrl} target="_blank" rel="noreferrer" />}><ExternalLink />GitHub run</Button>}
        </div>
        {!decidable && <DecisionSummary proposal={proposal} />}
        {decidable && stale && <Banner tone="danger" icon={TriangleAlert}><p className="font-semibold">Another sync committed after this one was prepared, so it can’t be approved.</p><p>Run the sync again to stage current changes, then review that one. You can still deny this one.</p></Banner>}
        {proposal.status === "failed" && proposal.result && <Banner tone="danger" icon={CircleX}><p className="font-semibold">The last approval rolled back. Nothing was committed.</p><p className="break-words">{String(proposal.result.error ?? "Unknown error")}</p></Banner>}
        {review && review.warnings.length > 0 && <Banner tone="warning" icon={TriangleAlert}><p className="font-semibold">The sync reported {plural(review.warnings.length, "warning")}</p><ul className="list-disc space-y-0.5 pl-4">{review.warnings.map((warning) => <li key={warning} className="break-words">{warning}</li>)}</ul></Banner>}
        {review?.notices.map((notice) => <Banner key={notice} tone="info" icon={Info}><p>{notice}</p></Banner>)}
        {decidable && review && review.roots.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {review.roots.map((root) => (
              <label key={root.root} className={cn("flex min-w-56 flex-1 cursor-pointer items-start gap-2.5 rounded-xl border bg-card px-3 py-2.5 sm:flex-none", rootSkipped(root.root) && "opacity-60")}>
                <Checkbox className="mt-0.5" checked={!rootSkipped(root.root)} disabled={busy || stale} onCheckedChange={(checked) => setApplied(`root:${root.root}`, Boolean(checked))} />
                <span className="min-w-0">
                  <span className="block font-mono text-xs font-bold text-primary">{root.root}</span>
                  <span className="block text-sm font-medium">{root.name || "Manufacturing root"}</span>
                  <span className="block text-xs text-muted-foreground">Rev {root.before ?? "—"} → {root.after} · {plural(root.changes, "change")}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        {!decidable && proposal.review && (
          <div className="flex flex-wrap gap-2">{proposal.review.roots.map((root) => (
            <span key={root.root} className={cn("rounded-lg border bg-card px-3 py-2 text-xs", !root.applied && "opacity-60")}>
              <span className="font-mono font-bold text-primary">{root.root}</span> rev {root.before ?? "—"} → {root.after}{root.applied || proposal.status === "denied" ? "" : " · skipped"}
            </span>
          ))}</div>
        )}
        {!decidable && !proposal.review && revisions.length > 0 && (
          <p className="text-xs text-muted-foreground">Roots: {revisions.map((revision) => `${revision.part_number} rev ${revision.revision}`).join(", ")}</p>
        )}
      </div>

      {decidable && review ? (
        <>
          <div className="flex flex-col gap-3 border-b p-3 md:flex-row md:items-center md:p-4">
            <div className="flex flex-wrap gap-1.5">
              {(["all", ...Object.keys(SYNC_CHANGE_LABELS)] as KindFilter[]).filter((value) => value === "all" || counts[value as SyncChangeKind] > 0).map((value) => (
                <Button key={value} size="sm" variant={kind === value ? "default" : "outline"} className="h-8" onClick={() => setKind(value)}>
                  {value === "all" ? "All" : SYNC_CHANGE_LABELS[value as SyncChangeKind]} <span className="opacity-70">{value === "all" ? review.changes.length : counts[value as SyncChangeKind]}</span>
                </Button>
              ))}
            </div>
            <div className="relative md:ml-auto md:w-72">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, assembly, field…" />
            </div>
          </div>
          {review.changes.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No engineering changes. Approving only records the new root revisions{review.bookkeeping ? ` and ${plural(review.bookkeeping, "link or position update")}` : ""}.</p>
          ) : visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No changes match.</p>
          ) : (
            <ul className="divide-y">
              {(showAll ? visible : visible.slice(0, INITIAL_ROWS)).map((change) => (
                <ChangeRow key={change.id} change={change} applied={applied(change)} rootSkipped={rootSkipped(change.root)}
                  disabled={busy || stale} excluded={excluded} onToggle={setApplied} />
              ))}
            </ul>
          )}
          {!showAll && visible.length > INITIAL_ROWS && <div className="border-t p-3 text-center"><Button variant="outline" onClick={() => setShowAll(true)}>Show all {visible.length} changes</Button></div>}
          <div className="sticky bottom-0 z-10 flex flex-col gap-3 border-t bg-card/95 p-3 backdrop-blur md:flex-row md:items-center md:p-4">
            <div className="text-sm md:mr-auto">
              <p className="font-semibold">{appliedCount} of {plural(reviewable.length, "change")} will be applied{skippedFields ? ` · ${plural(skippedFields, "field change")} skipped` : ""}</p>
              <p className="text-xs text-muted-foreground">{review.bookkeeping ? `${plural(review.bookkeeping, "link or position update")} also apply. ` : ""}Skipped changes aren’t proposed again until the root’s next release or a forced refresh.</p>
            </div>
            <Input value={note} maxLength={2000} disabled={busy} onChange={(event) => setNote(event.target.value)} className="h-9 md:w-72" placeholder="Note for the record (optional)" />
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={() => openConfirm("deny")}><Ban />Deny</Button>
              <Button disabled={busy || stale || allRootsSkipped} onClick={() => openConfirm("approve")}><CircleCheck />Approve</Button>
            </div>
          </div>
        </>
      ) : proposal.review ? (
        <StoredReviewList review={proposal.review} denied={proposal.status === "denied"} />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">{proposal.status === "superseded" ? "A newer sync replaced this one before anyone reviewed it." : "The change list for this sync is no longer stored."}</p>
      )}

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "approve" ? `Apply ${plural(appliedCount, "change")} to the shop?` : "Deny this sync?"}</DialogTitle>
            <DialogDescription>
              {confirm === "approve"
                ? `The changes commit in one transaction.${skippedSummary ? ` Skipped: ${skippedSummary}; the shop keeps its current values for those.` : ""} Removed requirements are deactivated, and obsolete work alerts its claimants.`
                : "Nothing is committed. The next sync run proposes these changes again while Onshape still differs."}
            </DialogDescription>
          </DialogHeader>
          {note.trim() && <p className="rounded-lg border bg-muted/40 p-3 text-sm">“{note.trim()}”</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant={confirm === "deny" ? "destructive" : "default"} disabled={busy} onClick={() => confirm && mutation.mutate(confirm)}>
              {busy && <LoaderCircle className="animate-spin" />}{confirm === "approve" ? "Approve and commit" : "Deny sync"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChangeRow({ change, applied, rootSkipped, disabled, excluded, onToggle }: {
  change: SyncChange; applied: boolean; rootSkipped: boolean; disabled: boolean; excluded: Set<string>;
  onToggle: (id: string, apply: boolean) => void;
}) {
  const toggleable = change.excludable && !rootSkipped && change.kind !== "membership";
  return (
    <li className={cn("flex gap-3 px-4 py-3", !applied && "bg-muted/30")}>
      <div className="w-4 shrink-0 pt-0.5">
        {change.kind !== "membership" && (
          <Checkbox aria-label={`Apply ${change.title}`} checked={applied} disabled={disabled || !toggleable}
            title={change.blockedReason ?? undefined} onCheckedChange={(checked) => onToggle(change.id, Boolean(checked))} />
        )}
      </div>
      <div className={cn("min-w-0 flex-1 space-y-1.5", !applied && "opacity-70")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant="outline" className={KIND_TONES[change.kind]}>{SYNC_CHANGE_LABELS[change.kind]}</Badge>
          <ChangeTitle title={change.title} />
          <span className="text-xs text-muted-foreground">{change.context}</span>
        </div>
        {change.fields.length ? (
          <ul className="space-y-1">
            {change.fields.map((field) => {
              const fieldApplied = applied && !excluded.has(field.id);
              return (
                <li key={field.id} className="text-sm">
                  <label className={cn("flex items-start gap-2", toggleable && applied && "cursor-pointer")}>
                    <Checkbox className="mt-0.5" aria-label={`Apply ${field.label}`} checked={fieldApplied}
                      disabled={disabled || !toggleable || !applied} onCheckedChange={(checked) => onToggle(field.id, Boolean(checked))} />
                    <span className={cn("min-w-0 break-words", !fieldApplied && "line-through decoration-muted-foreground/60")}>
                      <span className="font-medium">{field.label}</span> <span className="text-muted-foreground">{field.before}</span> → <span className="font-medium">{field.after}</span>
                    </span>
                  </label>
                  {field.notes.map((fieldNote) => <p key={fieldNote} className="ml-6 text-xs text-muted-foreground">{fieldNote}</p>)}
                </li>
              );
            })}
          </ul>
        ) : <p className="break-words text-sm">{change.summary}</p>}
        {change.details.length > 0 && <p className="break-words text-xs text-muted-foreground">{change.details.join(" · ")}</p>}
        {change.warnings.map((warning) => <p key={warning} className="flex items-start gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300"><TriangleAlert className="mt-px size-3.5 shrink-0" />{warning}</p>)}
        {change.notes.map((changeNote) => <p key={changeNote} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-px size-3.5 shrink-0" />{changeNote}</p>)}
        {!applied && <p className="text-xs font-semibold">{rootSkipped ? "Skipped with its root." : SKIPPED_MEANING[change.kind]}</p>}
        {change.blockedReason && change.kind !== "membership" && <p className="text-xs text-muted-foreground">{change.blockedReason}</p>}
      </div>
    </li>
  );
}

/** "P-190B-260100 · Roller plate": the part number in monospace, then its name. */
function ChangeTitle({ title }: { title: string }) {
  const [number, ...name] = title.split(" · ");
  return (
    <span className="min-w-0 text-sm">
      <span className="font-mono font-bold text-primary">{number}</span>
      {name.length > 0 && <span className="font-semibold"> {name.join(" · ")}</span>}
    </span>
  );
}

function DecisionSummary({ proposal }: { proposal: ProposalDetail }) {
  if (proposal.status === "superseded") return <Banner tone="info" icon={Info}><p>A newer sync replaced this one. Nothing from it was committed.</p></Banner>;
  const applied = proposal.review?.changes.filter((change) => change.applied).length ?? 0;
  const total = proposal.review?.changes.filter((change) => change.kind !== "membership").length ?? 0;
  return (
    <Banner tone="info" icon={proposal.status === "approved" ? CircleCheck : Ban}>
      <p className="font-semibold">
        {STATUS_LABELS[proposal.status]}{proposal.decidedBy ? ` by ${proposal.decidedBy}` : ""} · {formatDate(proposal.decidedAt)}
        {proposal.status === "approved" && total ? ` · ${applied} of ${plural(total, "change")} applied` : ""}
      </p>
      {describeSyncResult(proposal.result) && <p>{describeSyncResult(proposal.result)}</p>}
      {proposal.note && <p className="text-muted-foreground">“{proposal.note}”</p>}
    </Banner>
  );
}

function StoredReviewList({ review, denied }: { review: StoredSyncReview; denied: boolean }) {
  if (!review.changes.length) return <p className="p-6 text-center text-sm text-muted-foreground">This sync had no engineering changes.</p>;
  return (
    <ul className="divide-y">
      {review.changes.map((change) => (
        <li key={change.id} className={cn("space-y-1 px-4 py-3", !change.applied && "bg-muted/30")}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={KIND_TONES[change.kind]}>{SYNC_CHANGE_LABELS[change.kind]}</Badge>
            <ChangeTitle title={change.title} />
            <span className={cn("text-xs font-semibold", change.applied ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>{change.applied ? "Applied" : denied ? "Not applied" : "Skipped"}</span>
          </div>
          {change.fields.length ? change.fields.map((field) => (
            <p key={field.id} className={cn("text-sm", !field.applied && "text-muted-foreground line-through")}>{field.label} {field.before} → {field.after}</p>
          )) : <p className="text-sm">{change.summary}</p>}
        </li>
      ))}
    </ul>
  );
}
