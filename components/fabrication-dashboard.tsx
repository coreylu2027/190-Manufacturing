"use client";
import { ObsoleteBadge, ObsoleteWarning } from "@/components/requirement-obsoletion";
import { CopyPartNumber } from "@/components/copy-part-number";

import type { ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  ChevronDown,
  ListChecks,
  MapPin,
  CircleDot,
  LoaderCircle,
  PackageCheck,
  Paintbrush,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Timer,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { FilesAndSource } from "@/components/manufacturing-file-link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { mergeVisibleSelection, postBulk } from "@/lib/bulk-selection";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ProductionRequirementNotes } from "@/components/production-requirement-notes";
import { EngineeringOverrides } from "@/components/engineering-override-editor";
import { StorageLocationEditor, StorageLocationSelect } from "@/components/storage-location-editor";
import { BASE_ROW_SELECTION, DEFAULT_COL_DEF, isUserSelectionSource, partNumberColumn, SELECTION_COLUMN_DEF, syncGridSelection, workspaceGridTheme } from "@/components/workspace-grid";
import { EmptyState, PartModelPreview, StatTiles, StatusBadge, StatusCell } from "@/components/workspace-ui";
import { formatShortDateTime } from "@/lib/date-format";
import { onRobotAllowed } from "@/lib/obsoletion";
import { invalidateManufacturingQueries } from "@/lib/query-keys";
import { requestJson } from "@/lib/request-json";
import type { StorageLocation } from "@/lib/storage-locations";
import type { FabricationAction, FabricationActionPatch, FabricationJob, FabricationResponse, OperationStatus, OperationsResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

type QueueView = "available" | "mine" | "all";

const gridTheme = workspaceGridTheme(52);

function QcNotesCell({ value }: { value: string }) {
  const notes = value || "No inspection notes";
  return <div className="flex h-full min-w-0 items-center"><span className={cn("truncate", !value && "text-muted-foreground") } title={notes}>{notes}</span></div>;
}

function finishSwatchClass(color: string) {
  const value = color.toLocaleLowerCase();
  return value === "red" ? "bg-red-600" : value === "black" ? "bg-slate-900" : "bg-slate-300";
}

function FinishCell({ value }: { value: string }) {
  return <div className="flex h-full items-center gap-2 font-medium"><span className={cn("size-2.5 rounded-full border border-black/10", finishSwatchClass(value))} />{value}</div>;
}

function ActionCell({ data, onOpen, userName }: { data?: FabricationJob; userName: string; onOpen: (job: FabricationJob) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center justify-end">
      <Button size="sm" variant={!data.obsolete && data.active && data.status === "Ready" ? "default" : isStealable(data, userName) ? "destructive" : "ghost"} onClick={() => onOpen(data)}>
        {!data.obsolete && data.active && data.status === "Ready" ? "Claim" : isStealable(data, userName) ? "Steal" : "Open"}<ChevronRight />
      </Button>
    </div>
  );
}

function fetchFabrication() {
  return requestJson<FabricationResponse>("/api/fabrication", { cache: "no-store" }, "Unable to load finishing jobs");
}

function ownedBy(job: FabricationJob, userName: string) {
  return Boolean(job.machinist) && job.machinist.toLocaleLowerCase() === userName.toLocaleLowerCase();
}

function isStealable(job: FabricationJob, userName: string) {
  return !job.obsolete && job.active && job.status === "In Progress" && Boolean(job.machinist) && !ownedBy(job, userName);
}

const actionCopy: Record<FabricationAction, { success: string }> = {
  steal: { success: "Finishing job taken over" },
  claim: { success: "Finishing job claimed" },
  release: { success: "Finishing job released" },
  complete: { success: "Finishing marked complete" },
  undo_complete: { success: "Completion undone" },
};

const inverseAction: Record<Exclude<FabricationAction, "steal">, Exclude<FabricationAction, "steal">> = {
  claim: "release",
  release: "claim",
  complete: "undo_complete",
  undo_complete: "complete",
};

export function FabricationDashboard({
  user,
  ensureShopName,
}: {
  user: OperationsResponse["user"];
  /** False after asking the user to set a shop name first. */
  ensureShopName: () => boolean;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<QueueView>("available");
  const [color, setColor] = useState("all");
  const [search, setSearch] = useState("");
  const gridRef = useRef<AgGridReact<FabricationJob>>(null);
  const [bulkIds, setBulkIds] = useState<number[]>([]);
  const [bulkDialog, setBulkDialog] = useState<"claim" | "complete" | "release" | "location" | null>(null);
  const [bulkLocation, setBulkLocation] = useState<StorageLocation | null>(null);
  const [stealDialogOpen, setStealDialogOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const query = useQuery({ queryKey: ["fabrication"], queryFn: fetchFabrication });
  const jobs = useMemo(() => query.data?.jobs ?? [], [query.data?.jobs]);
  const selected = selectedId === null ? null : jobs.find((job) => job.id === selectedId) ?? null;
  const userName = user?.name ?? "Machinist";

  const mutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: FabricationActionPatch; suppressUndo?: boolean }) =>
      requestJson<{ updated?: Partial<FabricationJob>; notificationWarning?: string }>(`/api/fabrication/${id}`, {
        method: "PATCH", body: JSON.stringify(patch),
      }, "Unable to update finishing job"),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update finishing job"),
    onSuccess: (data, variables) => {
      queryClient.setQueryData<FabricationResponse>(["fabrication"], (current) => current ? {
        ...current,
        jobs: current.jobs.map((job) => job.id === variables.id ? { ...job, ...data.updated } : job),
      } : current);
      if (variables.patch.action === "steal") {
        setStealDialogOpen(false);
        toast.success(actionCopy.steal.success);
        if (data.notificationWarning) toast.warning(data.notificationWarning);
        return;
      }
      const undoAction = inverseAction[variables.patch.action];
      toast.success(actionCopy[variables.patch.action].success, variables.suppressUndo ? undefined : {
        action: {
          label: "Undo",
          onClick: () => mutation.mutate({
            id: variables.id,
            patch: { action: undoAction },
            suppressUndo: true,
          }),
        },
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["fabrication"] }, { cancelRefetch: false });
    },
  });

  const runAction = (action: FabricationAction) => {
    if (!selected) return;
    if (!ensureShopName()) return;
    if (action === "steal") { setStealDialogOpen(true); return; }
    mutation.mutate({ id: selected.id, patch: { action } });
  };

  const colors = useMemo(() => [...new Set(jobs.map((job) => job.color))].sort(), [jobs]);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return jobs.filter((job) => {
      if (color !== "all" && job.color !== color) return false;
      if (view === "available" && (job.obsolete || !job.active || (job.status !== "Ready" && !isStealable(job, userName)))) return false;
      if (view === "mine" && !(ownedBy(job, userName) && job.status === "In Progress")) return false;
      if (term && ![job.partNumber, job.partName, job.assemblyNumber, job.documentName, job.color, job.productionNotes, job.qcNotes, job.lastQualityFailure?.notes, job.machinist, job.storageLocation].join(" ").toLocaleLowerCase().includes(term)) return false;
      return true;
    });
  }, [color, jobs, search, userName, view]);

  const selectedJobs = jobs.filter((job) => bulkIds.includes(job.id));
  const claimable = selectedJobs.filter((job) => !job.obsolete && job.active && job.status === "Ready");
  const owned = selectedJobs.filter((job) => !job.obsolete && job.active && job.status === "In Progress" && ownedBy(job, userName));
  const primaryAction = selectedJobs.length > 0 && claimable.length === selectedJobs.length ? "claim" : selectedJobs.length > 0 && owned.length === selectedJobs.length ? "complete" : null;
  const primaryLabel = primaryAction === "complete" || view === "mine" ? "Bulk complete" : "Bulk claim";
  const locationJobs = [...new Map(selectedJobs.map((job) => [job.requirementId, job])).values()];
  const allowOnRobot = locationJobs.length > 0 && locationJobs.every((job) => onRobotAllowed({ ...job, activeInBom: job.active }, job.effectiveQcResult === "passed", job.status === "Complete"));
  const bulkMutation = useMutation({
    mutationFn: async ({ action, targets, location }: { action: "claim" | "complete" | "release" | "location"; targets: FabricationJob[]; location: StorageLocation | null; includesHidden: boolean }) => {
      const results = await postBulk(action === "location" ? "/api/requirements/bulk/location" : "/api/fabrication/bulk", targets, {
        body: (jobs) => action === "location"
          ? { requirementIds: jobs.map((job) => job.requirementId), location }
          : { action, ids: jobs.map((job) => job.id) },
        fallbackError: "Unable to update finishing job",
      });
      return {
        action,
        succeeded: results.flatMap((result, index) => result.status === "fulfilled" ? [targets[index]] : []),
        errors: results.flatMap((result, index) => result.status === "rejected"
          ? [`${targets[index].partNumber}: ${result.reason instanceof Error ? result.reason.message : "Unable to update finishing job"}`] : []),
      };
    },
    onSuccess: ({ action, succeeded, errors }) => {
      const done = new Set(selectedJobs.filter((job) => succeeded.some((success) => action === "location" ? success.requirementId === job.requirementId : success.id === job.id)).map((job) => job.id));
      setBulkIds((ids) => ids.filter((id) => !done.has(id)));
      if (errors.length) toast.warning(`Updated ${succeeded.length} finishing jobs; ${errors.length} failed and remain selected.`, { description: errors.join("; ") });
      else { toast.success(`${action === "location" ? "Location updated" : actionCopy[action].success}: ${succeeded.length}`); setBulkDialog(null); }
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => { void invalidateManufacturingQueries(queryClient); },
  });
  const bulkBusy = mutation.isPending || bulkMutation.isPending;
  // Each claim, completion or release changes a job's status, so while a batch runs the live
  // claimable/owned lists would shrink (and drop out of the filters); keep showing the jobs the
  // batch started with, and whether any of them were hidden then.
  const runningBatch = bulkMutation.isPending && bulkMutation.variables.action !== "location" ? bulkMutation.variables : null;
  const dialogJobs = runningBatch?.targets ?? (bulkDialog === "location" ? selectedJobs : bulkDialog === "claim" ? claimable : owned);
  const includesHiddenJobs = runningBatch?.includesHidden ?? dialogJobs.some((job) => !filtered.some((row) => row.id === job.id));
  const openBulk = (action: NonNullable<typeof bulkDialog>) => {
    if (action !== "location" && !ensureShopName()) return;
    setBulkLocation(null);
    setBulkDialog(action);
  };
  const rowSelection = useMemo(() => ({
    ...BASE_ROW_SELECTION,
    selectAll: "all" as const,
    isRowSelectable: () => Boolean(user?.approved),
  }), [user?.approved]);
  const syncSelection = useCallback(() => {
    syncGridSelection(gridRef.current?.api, (job) => bulkIds.includes(job.id));
  }, [bulkIds]);
  useEffect(() => { syncSelection(); }, [syncSelection, filtered]);

  const stats = useMemo(() => ({
    ready: jobs.filter((job) => !job.obsolete && job.active && job.status === "Ready").length,
    active: jobs.filter((job) => job.status === "In Progress").length,
    waiting: jobs.filter((job) => job.status === "Planned").length,
    complete: jobs.filter((job) => job.status === "Complete").length,
  }), [jobs]);

  const openJob = (job: FabricationJob) => { setStealDialogOpen(false); setSelectedId(job.id); };
  const columnDefs = useMemo<ColDef<FabricationJob>[]>(() => [
    partNumberColumn,
    { field: "partName", headerName: "DESCRIPTION", minWidth: 230, flex: 1 },
    { field: "documentName", headerName: "SOURCE DOCUMENT", minWidth: 175, valueFormatter: ({ value }) => value || "Not synced" },
    { field: "quantity", headerName: "REQUIRED", width: 105, filter: "agNumberColumnFilter" },
    { field: "color", headerName: "FINISH", minWidth: 125, cellRenderer: FinishCell },
    { field: "storageLocation", headerName: "LOCATION", minWidth: 150, valueFormatter: ({ value }) => value || "Not recorded" },
    { field: "qcNotes", headerName: "QC NOTES", minWidth: 240, flex: 1, cellRenderer: QcNotesCell },
    { field: "status", headerName: "STATUS", minWidth: 145, cellRenderer: StatusCell },
    { field: "machinist", headerName: "MACHINIST", minWidth: 180, valueFormatter: ({ value }) => value || "—" },
    { headerName: "", width: 102, pinned: "right", sortable: false, filter: false, resizable: false, cellRenderer: ActionCell, cellRendererParams: { onOpen: openJob, userName } },
  ], [userName]);

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-fuchsia-500 shadow-[0_0_0_4px_rgba(217,70,239,.12)]" /> Finishing queue</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Finishing</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Claim parts that have passed QC, confirm the specified powder-coat color, and record completed finishing work.</p>
        </div>
        <StatTiles className="grid grid-cols-2 gap-2 sm:grid-cols-4" items={[
          { label: "Ready", value: stats.ready, icon: CircleDot, tone: "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-400/15" },
          { label: "In progress", value: stats.active, icon: Timer, tone: "text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-400/15" },
          { label: "Upstream", value: stats.waiting, icon: TriangleAlert, tone: "text-amber-800 bg-amber-50 dark:text-amber-300 dark:bg-amber-400/15" },
          { label: "Complete", value: stats.complete, icon: Check, tone: "text-violet-700 bg-violet-50 dark:text-violet-300 dark:bg-violet-400/15" },
        ]} />
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
        <div className="border-b bg-muted/25 p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex w-full overflow-x-auto rounded-lg bg-muted p-1 sm:w-auto">
              {([{ id: "available", label: "Available" }, { id: "mine", label: "My work" }, { id: "all", label: "All finishing" }] as const).map((item) => (
                <Button key={item.id} size="sm" variant="ghost" onClick={() => setView(item.id)} className={cn("min-w-fit", view === item.id && "bg-card text-foreground shadow-sm hover:bg-card")}>
                  {item.label}{item.id === "available" && <span className="ml-1 rounded bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200">{stats.ready}</span>}
                </Button>
              ))}
            </div>
            <div className="order-2 grid w-full basis-full grid-cols-1 gap-3 sm:grid-cols-[minmax(15rem,1fr)_13rem]">
            <div className="relative min-w-0">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, assembly, color…" />
            </div>
            <Select value={color} onValueChange={(value) => setColor(value ?? "all")}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-52"><Paintbrush className="text-muted-foreground" /><SelectValue placeholder="All finishes" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All finishes</SelectItem>{colors.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            </div>
            <div className="order-1 flex w-full items-center justify-between gap-3 sm:ml-auto sm:w-auto">
              <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground"><SlidersHorizontal className="size-3.5" />{filtered.length} shown{selectedJobs.length > 0 ? ` · ${selectedJobs.length} selected` : ""}</div>
              <div className="flex items-center gap-1">
                <Button size="sm" disabled={bulkBusy || !user?.approved || !primaryAction} onClick={() => primaryAction && openBulk(primaryAction)} title={!primaryAction && selectedJobs.length ? "Select only claimable work or only work assigned to you" : undefined}><ListChecks />{primaryLabel}{primaryAction ? ` (${selectedJobs.length})` : ""}</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button size="sm" variant="outline" className="w-8 px-0" aria-label="More bulk actions" disabled={bulkBusy || !user?.approved} />}><ChevronDown className="size-4" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem disabled={!locationJobs.length} onClick={() => openBulk("location")}><MapPin />Bulk set location{locationJobs.length ? ` (${locationJobs.length})` : ""}</DropdownMenuItem>
                    <DropdownMenuItem disabled={!owned.length} onClick={() => openBulk("release")}><RotateCcw />Bulk release claim{owned.length ? ` (${owned.length})` : ""}</DropdownMenuItem>
                    <DropdownMenuItem disabled={!filtered.length} onClick={() => setBulkIds((ids) => mergeVisibleSelection(ids, filtered.map((job) => job.id), filtered.map((job) => job.id)))}>Select visible parts</DropdownMenuItem>
                    <DropdownMenuItem disabled={!bulkIds.length} onClick={() => setBulkIds([])}>Clear selection</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
        ) : query.isError && !query.data ? (
          <EmptyState icon={XCircle} iconClassName="size-9 text-destructive" title="Couldn’t load finishing" message={query.error.message} messageClassName="max-w-md"><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></EmptyState>
        ) : filtered.length === 0 ? (
          <EmptyState icon={Sparkles} iconClassName="size-10 text-muted-foreground/60" title="No finishing jobs match" message="Try another finish or clear the search."><Button variant="outline" className="mt-4" onClick={() => { setColor("all"); setSearch(""); setView("all"); }}>Clear filters</Button></EmptyState>
        ) : (
          <>
            <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
              <AgGridReact<FabricationJob>
                ref={gridRef}
                rowSelection={rowSelection}
                selectionColumnDef={SELECTION_COLUMN_DEF}
                onGridReady={syncSelection}
                onRowDataUpdated={syncSelection}
                onSelectionChanged={({ api, source }) => {
                  if (!isUserSelectionSource(source)) return;
                  setBulkIds((ids) => mergeVisibleSelection(ids, filtered.map((job) => job.id), api.getSelectedRows().map((job) => job.id)));
                }}
                theme={gridTheme}
                rowData={filtered}
                columnDefs={columnDefs}
                defaultColDef={DEFAULT_COL_DEF}
                getRowId={({ data }) => String(data.id)}
                onRowDoubleClicked={({ data }) => data && openJob(data)}
                pagination
                paginationPageSize={25}
                paginationPageSizeSelector={[10, 25, 50]}
                animateRows
              />
            </div>
            <div className="divide-y md:hidden">
              {filtered.map((job) => (
                <article key={job.id} className="flex items-center gap-3 p-4 text-left transition hover:bg-muted/40">
                  <Checkbox aria-label={`Select ${job.partNumber}`} checked={bulkIds.includes(job.id)} disabled={bulkBusy || !user?.approved} onCheckedChange={(checked) => setBulkIds((ids) => checked ? [...new Set([...ids, job.id])] : ids.filter((id) => id !== job.id))} />
                  <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-primary"><CopyPartNumber partNumber={job.partNumber} /> <ObsoleteBadge obsolete={job.obsolete} /></p><h3 className="mt-1 font-semibold">{job.partName}</h3><p className="mt-1 font-mono text-[11px] text-muted-foreground">{job.documentName ?? "Document not synced"}</p></div><StatusBadge status={job.status} /></div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Paintbrush className="size-3" />{job.color}</span><span>{job.quantity} required</span><span>{job.machinist || "Unclaimed"}</span><span>Location: {job.storageLocation ?? "Not recorded"}</span></div>
                  <p className={cn("mt-2 line-clamp-2 text-xs", job.qcNotes ? "text-foreground" : "text-muted-foreground")}>QC notes: {job.qcNotes || "No inspection notes"}</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => openJob(job)}>Open<ChevronRight /></Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Finishing jobs become available after manufacturing QC passes.</span><span>Last refreshed {query.data ? formatShortDateTime(query.data.syncedAt) : "—"}</span></div>

      <Dialog open={bulkDialog !== null} onOpenChange={(open) => { if (!bulkMutation.isPending && !open) setBulkDialog(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{bulkDialog === "location" ? "Bulk set location" : bulkDialog === "release" ? "Bulk release claim" : bulkDialog === "complete" ? "Bulk complete finishing" : "Bulk claim finishing"}</DialogTitle><DialogDescription>{bulkDialog === "location" ? locationJobs.length : dialogJobs.length} selected {bulkDialog === "location" ? "part requirements" : "finishing jobs"}. Applies to the full quantity of each job.</DialogDescription></DialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">{dialogJobs.map((job) => <li key={job.id}><CopyPartNumber partNumber={job.partNumber} /> · {job.color} · Qty {job.quantity}</li>)}</ul>
          {includesHiddenJobs && <p className="text-xs text-amber-700 dark:text-amber-300">Includes selected jobs hidden by the current filters.</p>}
          {bulkDialog === "release" && <p className="text-xs text-muted-foreground">Only your active claims are released; other selected jobs are skipped.</p>}
          {bulkDialog === "location" && <><StorageLocationSelect value={bulkLocation} onChange={setBulkLocation} disabled={bulkBusy} emptyLabel="Choose a location" allowOnRobot={allowOnRobot} />{!allowOnRobot && <p className="text-xs text-muted-foreground">On Robot requires active parts with passed QC and completed finishing.</p>}</>}
          <DialogFooter><Button variant="outline" disabled={bulkMutation.isPending} onClick={() => setBulkDialog(null)}>Cancel</Button><Button disabled={bulkBusy || !dialogJobs.length || !user?.approved || (bulkDialog === "location" && (!bulkLocation || bulkLocation === "On Robot" && !allowOnRobot))} onClick={() => { if (bulkDialog) bulkMutation.mutate({ action: bulkDialog, targets: bulkDialog === "location" ? locationJobs : dialogJobs, location: bulkLocation, includesHidden: includesHiddenJobs }); }}>{bulkMutation.isPending && <LoaderCircle className="animate-spin" />}{bulkDialog === "location" ? "Set location" : bulkDialog === "release" ? "Release claims" : bulkDialog === "complete" ? "Mark complete" : "Claim jobs"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent detailView className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="border-b p-6 pr-14">
                <div className="mb-2 flex flex-wrap items-center gap-2"><StatusBadge status={selected.status} /><Badge variant="outline" className="gap-1.5"><span className={cn("size-2 rounded-full", finishSwatchClass(selected.color))} />{selected.color}</Badge></div>
                <SheetTitle className="text-2xl font-bold tracking-tight">{selected.partName} <ObsoleteBadge obsolete={selected.obsolete} /></SheetTitle>
                <SheetDescription className="font-mono text-xs font-semibold text-primary"><CopyPartNumber partNumber={selected.partNumber} /></SheetDescription>
              </SheetHeader>

              <div className="detail-sections p-6"><div className="detail-columns space-y-6">
                <ObsoleteWarning obsolete={selected.obsolete} onRobot={selected.storageLocation === "On Robot"} />
                {selected.requirementId && (
                  <section>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">3D part preview</h3>
                    <PartModelPreview
                      src={`/api/fabrication/${selected.id}/preview`}
                      partName={`${selected.partNumber} ${selected.partName}`}
                    />
                  </section>
                )}

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Finishing details</h3>
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border">
                    {[
                      ["Finish", selected.color], ["Required", String(selected.quantity)],
                      ["Upstream status", selected.requirementStatus], ["Source document", selected.documentName || "Not synced"],
                      ["Machinist", selected.machinist || "Unclaimed"], ["Last synced", formatShortDateTime(selected.lastSyncedAt)],
                    ].map(([label, value], index) => <div key={label} className={cn("p-3", index % 2 === 0 && "border-r", index < 4 && "border-b")}><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}
                  </div>
                </section>

                <ProductionRequirementNotes
                  key={selected.requirementId}
                  requirementId={selected.requirementId}
                  notes={selected.productionNotes}
                />

                {user?.role === "admin" && user.approved && (
                  <EngineeringOverrides
                    key={`engineering:${selected.requirementId}`}
                    requirementId={selected.requirementId}
                    partNumber={selected.partNumber}
                    obsolete={selected.obsolete}
                    activeInBom={selected.active}
                    compact
                  />
                )}

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">QC inspection notes</h3>
                  <p className={cn("whitespace-pre-wrap rounded-xl border p-4 text-sm leading-6", selected.qcNotes ? "bg-emerald-50/60 text-foreground dark:bg-emerald-400/10" : "border-dashed bg-muted/30 text-muted-foreground")}>
                    {selected.qcNotes || "No inspection notes were recorded."}
                  </p>
                </section>

                <section>
                  <StorageLocationEditor
                    requirementId={selected.requirementId}
                    value={selected.storageLocation}
                    updatedBy={selected.locationUpdatedBy}
                    updatedAt={selected.locationUpdatedAt}
                    allowOnRobot={onRobotAllowed({ ...selected, activeInBom: selected.active }, selected.effectiveQcResult === "passed", selected.status === "Complete")}
                  />
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Finishing progress</h3>
                  <div className="flex items-center">
                    {(["Planned", "Ready", "In Progress", "Complete"] as OperationStatus[]).map((status, index, steps) => {
                      const statusIndex = steps.indexOf(selected.status);
                      const active = statusIndex >= index || selected.status === "Complete";
                      return <div key={status} className="flex flex-1 items-center last:flex-none"><div className={cn("grid size-7 place-items-center rounded-full border text-[10px] font-bold", active ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{active ? <Check className="size-3.5" /> : index + 1}</div>{index < steps.length - 1 && <div className={cn("h-0.5 flex-1", statusIndex > index ? "bg-primary" : "bg-border")} />}</div>;
                    })}
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] font-semibold text-muted-foreground"><span>Upstream</span><span>Ready</span><span>Finishing</span><span>Done</span></div>
                </section>

                <FilesAndSource basePath="/api/fabrication" part={selected} onshapeUrl={selected.onshapeUrl} />
              </div></div>

              <SheetFooter className="sticky bottom-0 border-t bg-card/95 p-4 backdrop-blur">
                {isStealable(selected, userName) && <Button size="lg" variant="destructive" onClick={() => runAction("steal")} disabled={bulkBusy}><TriangleAlert /> Steal finishing job</Button>}
                {selected.status === "Ready" && <Button size="lg" className="h-11" onClick={() => runAction("claim")} disabled={mutation.isPending || selected.obsolete || !selected.active}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <CircleDot />} Claim finishing job</Button>}
                {selected.status === "In Progress" && ownedBy(selected, userName) && <Button size="lg" className="h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => runAction("complete")} disabled={mutation.isPending || selected.obsolete || !selected.active}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Mark complete</Button>}
                {selected.status === "In Progress" && ownedBy(selected, userName) && <Button variant="outline" onClick={() => runAction("release")} disabled={mutation.isPending || selected.obsolete || !selected.active}><RotateCcw /> Release claim</Button>}
                {selected.status === "Complete" && ownedBy(selected, userName) && <Button variant="outline" onClick={() => runAction("undo_complete")} disabled={mutation.isPending || selected.obsolete || !selected.active}><RotateCcw /> Undo completion</Button>}
                {selected.status === "Complete" && <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-200"><Check className="size-4" /> {selected.quantity} finished by {selected.machinist || "machinist"}</div>}
                {selected.status === "Planned" && <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 p-3 text-sm font-semibold text-slate-700 dark:bg-slate-400/15 dark:text-slate-200"><PackageCheck className="size-4" /> Waiting on manufacturing and QC</div>}
                <Button variant="outline" onClick={() => setSelectedId(null)}>Close</Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
      <Dialog open={stealDialogOpen && Boolean(selected)} onOpenChange={setStealDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Steal this finishing job?</DialogTitle>
            <DialogDescription>This transfers finishing for {selected?.partNumber} ({selected?.quantity} parts) from {selected?.machinist} to you. The previous machinist will be notified when their account can be identified.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStealDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={bulkBusy || !selected || !isStealable(selected, userName)} onClick={() => selected && mutation.mutate({ id: selected.id, patch: { action: "steal", confirmed: true } })}>
              {mutation.isPending && <LoaderCircle className="animate-spin" />} Yes, steal finishing job
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
