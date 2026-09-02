"use client";

import { themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleDot,
  Cloud,
  Download,
  FileText,
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
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { isShopName } from "@/lib/profile-name";
import type { FabricationAction, FabricationActionPatch, FabricationJob, FabricationResponse, OperationStatus, OperationsResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

type QueueView = "available" | "mine" | "all";

const gridTheme = themeQuartz.withParams({
  accentColor: "#3159c6",
  backgroundColor: "#ffffff",
  borderColor: "#dce2ec",
  foregroundColor: "#172033",
  headerBackgroundColor: "#f7f9fc",
  headerTextColor: "#697386",
  rowHoverColor: "#f4f7fb",
  selectedRowBackgroundColor: "#eaf0ff",
  fontFamily: "var(--font-geist-sans), ui-sans-serif",
  fontSize: 13,
  headerFontSize: 11,
  headerFontWeight: 650,
  rowHeight: 52,
  headerHeight: 42,
  wrapperBorderRadius: 0,
  spacing: 6,
});

const statusStyles: Record<OperationStatus, string> = {
  Planned: "border-slate-200 bg-slate-100 text-slate-700",
  Ready: "border-emerald-200 bg-emerald-100 text-emerald-800",
  "In Progress": "border-blue-200 bg-blue-100 text-blue-800",
  Blocked: "border-amber-200 bg-amber-100 text-amber-900",
  "Needs Rework": "border-rose-200 bg-rose-100 text-rose-800",
  Complete: "border-violet-200 bg-violet-100 text-violet-800",
};

function StatusBadge({ status }: { status: OperationStatus }) {
  return <Badge variant="outline" className={cn("font-semibold", statusStyles[status])}>{status}</Badge>;
}

function StatusCell({ value }: { value: OperationStatus }) {
  return <div className="flex h-full items-center"><StatusBadge status={value} /></div>;
}

function FinishCell({ value }: { value: string }) {
  const swatch = value.toLocaleLowerCase() === "red" ? "bg-red-600" : value.toLocaleLowerCase() === "black" ? "bg-slate-900" : "bg-slate-300";
  return <div className="flex h-full items-center gap-2 font-medium"><span className={cn("size-2.5 rounded-full border border-black/10", swatch)} />{value}</div>;
}

function ActionCell({ data, onOpen }: { data?: FabricationJob; onOpen: (job: FabricationJob) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center justify-end">
      <Button size="sm" variant={data.status === "Ready" ? "default" : "ghost"} onClick={() => onOpen(data)}>
        {data.status === "Ready" ? "Claim" : "Open"}<ChevronRight />
      </Button>
    </div>
  );
}

async function fetchFabrication(): Promise<FabricationResponse> {
  const response = await fetch("/api/fabrication", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to load finishing jobs");
  return body;
}

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function ownedBy(job: FabricationJob, userName: string) {
  return Boolean(job.machinist) && job.machinist.toLocaleLowerCase() === userName.toLocaleLowerCase();
}

const actionCopy: Record<FabricationAction, { success: string }> = {
  claim: { success: "Finishing job claimed" },
  release: { success: "Finishing job released" },
  complete: { success: "Finishing marked complete" },
  undo_complete: { success: "Completion undone" },
};

const inverseAction: Record<FabricationAction, FabricationAction> = {
  claim: "release",
  release: "claim",
  complete: "undo_complete",
  undo_complete: "complete",
};

export function FabricationDashboard({
  user,
  onProfileRequired,
}: {
  user: OperationsResponse["user"];
  onProfileRequired: () => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<QueueView>("available");
  const [color, setColor] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const query = useQuery({ queryKey: ["fabrication"], queryFn: fetchFabrication });
  const jobs = useMemo(() => query.data?.jobs ?? [], [query.data?.jobs]);
  const selected = selectedId === null ? null : jobs.find((job) => job.id === selectedId) ?? null;
  const userName = user?.name ?? "Machinist";

  const mutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: FabricationActionPatch; suppressUndo?: boolean }) => {
      const response = await fetch(`/api/fabrication/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to update finishing job");
      return body;
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update finishing job"),
    onSuccess: (data, variables) => {
      queryClient.setQueryData<FabricationResponse>(["fabrication"], (current) => current ? {
        ...current,
        jobs: current.jobs.map((job) => job.id === variables.id ? { ...job, ...data.updated } : job),
      } : current);
      toast.success(actionCopy[variables.patch.action].success, variables.suppressUndo ? undefined : {
        action: {
          label: "Undo",
          onClick: () => mutation.mutate({
            id: variables.id,
            patch: { action: inverseAction[variables.patch.action] },
            suppressUndo: true,
          }),
        },
      });
    },
    onSettled: () => {
      if (query.data?.source === "baserow") queryClient.invalidateQueries({ queryKey: ["fabrication"] });
    },
  });

  const runAction = (action: FabricationAction) => {
    if (!selected) return;
    if (!isShopName(userName)) {
      onProfileRequired();
      toast.info("Set your first name and last initial before recording work");
      return;
    }
    mutation.mutate({ id: selected.id, patch: { action } });
  };

  const colors = useMemo(() => [...new Set(jobs.map((job) => job.color))].sort(), [jobs]);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return jobs.filter((job) => {
      if (color !== "all" && job.color !== color) return false;
      if (view === "available" && job.status !== "Ready") return false;
      if (view === "mine" && !(ownedBy(job, userName) && job.status === "In Progress")) return false;
      if (term && ![job.partNumber, job.partName, job.documentName, job.color, job.machinist].join(" ").toLocaleLowerCase().includes(term)) return false;
      return true;
    });
  }, [color, jobs, search, userName, view]);

  const stats = useMemo(() => ({
    ready: jobs.filter((job) => job.status === "Ready").length,
    active: jobs.filter((job) => job.status === "In Progress").length,
    waiting: jobs.filter((job) => job.status === "Planned" || job.status === "Needs Rework").length,
    complete: jobs.filter((job) => job.status === "Complete").length,
  }), [jobs]);

  const openJob = (job: FabricationJob) => setSelectedId(job.id);
  const columnDefs = useMemo<ColDef<FabricationJob>[]>(() => [
    { field: "partNumber", headerName: "PART", minWidth: 155, pinned: "left", cellClass: "font-mono font-semibold" },
    { field: "partName", headerName: "DESCRIPTION", minWidth: 230, flex: 1 },
    { field: "documentName", headerName: "SOURCE DOCUMENT", minWidth: 175, valueFormatter: ({ value }) => value || "Not synced" },
    { field: "quantity", headerName: "REQUIRED", width: 105, filter: "agNumberColumnFilter" },
    { field: "color", headerName: "FINISH", minWidth: 125, cellRenderer: FinishCell },
    { field: "status", headerName: "STATUS", minWidth: 145, cellRenderer: StatusCell },
    { field: "machinist", headerName: "MACHINIST", minWidth: 180, valueFormatter: ({ value }) => value || "—" },
    { headerName: "", width: 102, pinned: "right", sortable: false, filter: false, resizable: false, cellRenderer: ActionCell, cellRendererParams: { onOpen: openJob } },
  ], []);

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-fuchsia-500 shadow-[0_0_0_4px_rgba(217,70,239,.12)]" /> Finishing queue</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Finishing</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Claim parts that have passed QC, confirm the specified powder-coat color, and record completed finishing work.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Ready", value: stats.ready, icon: CircleDot, tone: "text-emerald-700 bg-emerald-50" },
            { label: "In progress", value: stats.active, icon: Timer, tone: "text-blue-700 bg-blue-50" },
            { label: "Upstream", value: stats.waiting, icon: TriangleAlert, tone: "text-amber-800 bg-amber-50" },
            { label: "Complete", value: stats.complete, icon: Check, tone: "text-violet-700 bg-violet-50" },
          ].map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className="flex min-w-32 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm">
              <div className={cn("grid size-8 place-items-center rounded-lg", tone)}><Icon className="size-4" /></div>
              <div><div className="text-lg font-bold leading-none">{value}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div></div>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
        <div className="border-b bg-muted/25 p-3 md:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="flex w-full overflow-x-auto rounded-lg bg-muted p-1 xl:w-auto">
              {([{ id: "available", label: "Available" }, { id: "mine", label: "My work" }, { id: "all", label: "All finishing" }] as const).map((item) => (
                <Button key={item.id} size="sm" variant="ghost" onClick={() => setView(item.id)} className={cn("min-w-fit", view === item.id && "bg-card text-foreground shadow-sm hover:bg-card")}>
                  {item.label}{item.id === "available" && <span className="ml-1 rounded bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-800">{stats.ready}</span>}
                </Button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, assembly, color…" />
            </div>
            <Select value={color} onValueChange={(value) => setColor(value ?? "all")}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-52"><Paintbrush className="text-muted-foreground" /><SelectValue placeholder="All finishes" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All finishes</SelectItem>{colors.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><SlidersHorizontal className="size-3.5" /> {filtered.length} shown</div>
          </div>
        </div>

        {query.isLoading ? (
          <div className="space-y-3 p-5">{Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} className="h-11 w-full" />)}</div>
        ) : query.isError ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><XCircle className="mx-auto mb-3 size-9 text-destructive" /><h2 className="font-semibold">Couldn’t load finishing</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
        ) : filtered.length === 0 ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><Sparkles className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No finishing jobs match</h2><p className="mt-1 text-sm text-muted-foreground">Try another finish or clear the search.</p><Button variant="outline" className="mt-4" onClick={() => { setColor("all"); setSearch(""); setView("all"); }}>Clear filters</Button></div></div>
        ) : (
          <>
            <div className="hidden h-[min(59vh,680px)] min-h-[430px] md:block">
              <AgGridReact<FabricationJob>
                theme={gridTheme}
                rowData={filtered}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, filter: false, resizable: true }}
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
                <button key={job.id} onClick={() => openJob(job)} className="block w-full p-4 text-left transition hover:bg-muted/40">
                  <div className="flex items-start justify-between gap-3"><div><p className="font-mono text-xs font-bold text-primary">{job.partNumber}</p><h3 className="mt-1 font-semibold">{job.partName}</h3><p className="mt-1 font-mono text-[11px] text-muted-foreground">{job.documentName ?? "Document not synced"}</p></div><StatusBadge status={job.status} /></div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="flex items-center gap-1"><Paintbrush className="size-3" />{job.color}</span><span>{job.quantity} required</span><span>{job.machinist || "Unclaimed"}</span></div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span>Finishing jobs become available after manufacturing QC passes.</span><span>Last refreshed {query.data ? formatDate(query.data.syncedAt) : "—"}</span></div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader className="border-b p-6 pr-14">
                <div className="mb-2 flex items-center gap-2"><StatusBadge status={selected.status} /><Badge variant="outline" className="gap-1.5"><span className={cn("size-2 rounded-full", selected.color.toLocaleLowerCase() === "red" ? "bg-red-600" : "bg-slate-900")} />{selected.color}</Badge></div>
                <SheetTitle className="text-2xl font-bold tracking-tight">{selected.partName}</SheetTitle>
                <SheetDescription className="font-mono text-xs font-semibold text-primary">{selected.partNumber}</SheetDescription>
              </SheetHeader>

              <div className="space-y-6 p-6">
                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Finishing details</h3>
                  <div className="grid grid-cols-2 overflow-hidden rounded-xl border">
                    {[
                      ["Finish", selected.color], ["Required", String(selected.quantity)],
                      ["Source document", selected.documentName || "Not synced"], ["Machinist", selected.machinist || "Unclaimed"],
                      ["Upstream status", selected.requirementStatus], ["Last synced", formatDate(selected.lastSyncedAt)],
                    ].map(([label, value], index) => <div key={label} className={cn("p-3", index % 2 === 0 && "border-r", index < 4 && "border-b")}><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>)}
                  </div>
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

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Files & source</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {[
                      { label: "Drawing PDF", href: selected.drawingPdfUrl ? `/api/fabrication/${selected.id}/files/drawing-pdf` : null, fileName: selected.drawingPdfName, icon: FileText },
                      { label: "STEP file", href: selected.stepUrl ? `/api/fabrication/${selected.id}/files/step` : null, fileName: selected.stepName, icon: Download },
                      { label: "Onshape drawing", href: selected.drawingUrl, fileName: null, icon: ArrowUpRight },
                      { label: "BOM source", href: selected.onshapeUrl, fileName: null, icon: Cloud },
                    ].map(({ label, href, fileName, icon: Icon }) => href ? (
                      <a key={label} href={href} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-3 rounded-xl border p-3 text-sm font-semibold transition hover:border-primary/40 hover:bg-accent/40"><div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></div><span className="min-w-0"><span className="block">{label}</span>{fileName && <span className="block truncate text-[10px] font-normal text-muted-foreground">{fileName}</span>}</span><ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" /></a>
                    ) : (
                      <div key={label} className="flex items-center gap-3 rounded-xl border border-dashed p-3 text-sm text-muted-foreground"><div className="grid size-8 place-items-center rounded-lg bg-muted"><Icon className="size-4" /></div>{label}<span className="ml-auto text-[10px] uppercase">Missing</span></div>
                    ))}
                  </div>
                </section>
              </div>

              <SheetFooter className="sticky bottom-0 border-t bg-card/95 p-4 backdrop-blur">
                {selected.status === "Ready" && <Button size="lg" className="h-11" onClick={() => runAction("claim")} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <CircleDot />} Claim finishing job</Button>}
                {selected.status === "In Progress" && ownedBy(selected, userName) && <Button size="lg" className="h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => runAction("complete")} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Mark complete</Button>}
                {selected.status === "In Progress" && ownedBy(selected, userName) && <Button variant="outline" onClick={() => runAction("release")} disabled={mutation.isPending}><RotateCcw /> Release claim</Button>}
                {selected.status === "Complete" && ownedBy(selected, userName) && <Button variant="outline" onClick={() => runAction("undo_complete")} disabled={mutation.isPending}><RotateCcw /> Undo completion</Button>}
                {selected.status === "Complete" && <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><Check className="size-4" /> {selected.quantity} finished by {selected.machinist || "machinist"}</div>}
                {selected.status === "Planned" && <div className="flex items-center justify-center gap-2 rounded-xl bg-slate-100 p-3 text-sm font-semibold text-slate-700"><PackageCheck className="size-4" /> Waiting on manufacturing and QC</div>}
                <Button variant="outline" onClick={() => setSelectedId(null)}>Close</Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}
