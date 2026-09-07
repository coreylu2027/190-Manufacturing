"use client";

import { ForceQcPicker } from "@/components/force-qc";

import { themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  MapPin,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { StorageLocationEditor } from "@/components/storage-location-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { canUseOnRobotLocation } from "@/lib/storage-locations";
import type { AdminResponse, QualityControlItem, QualityResult } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  rowHeight: 132,
  headerHeight: 42,
  wrapperBorderRadius: 0,
  spacing: 6,
});

const resultStyles: Record<QualityResult, string> = {
  pending: "border-amber-200 bg-amber-50 text-amber-800",
  passed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
};

const resultLabels: Record<QualityResult, string> = {
  pending: "Awaiting QC",
  passed: "QC passed",
  failed: "QC failed",
};

interface QualityControlGridRow extends QualityControlItem {
  draftNotes: string;
}

async function fetchQualityControl(): Promise<AdminResponse> {
  const response = await fetch("/api/admin", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to load quality control");
  return body;
}

async function submitReview(item: QualityControlItem, result: "passed" | "failed", notes: string) {
  const response = await fetch(`/api/admin/qc/${item.requirementId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result, notes }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to record the quality review");
  return body;
}

async function undoPassedReview(item: QualityControlItem) {
  const response = await fetch(`/api/admin/qc/${item.requirementId}`, { method: "DELETE" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to undo the QC pass");
  return body;
}

function formatDate(value: string | null) {
  if (!value) return "Not reviewed";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function completedBy(item: QualityControlItem) {
  return [...new Set(item.operations.flatMap((operation) => operation.allocations.filter((allocation) => allocation.completed > 0).map((allocation) => allocation.name)))].join(", ") || "Machinist";
}

function ResultBadge({ result }: { result: QualityResult }) {
  return <Badge variant="outline" className={cn("font-semibold", resultStyles[result])}>{resultLabels[result]}</Badge>;
}

function PartCell({ data }: { data?: QualityControlItem }) {
  if (!data) return null;
  const operation = data.operations[0];
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <span className="font-mono text-xs font-bold text-primary">{operation.partNumber}</span>
      <span className="mt-1.5 truncate font-semibold" title={operation.partName}>{operation.partName}</span>
      <span className="mt-1.5 truncate text-[11px] text-muted-foreground" title={`Completed by ${completedBy(data)}`}>Qty {operation.quantity} · {completedBy(data)}</span>
    </div>
  );
}

function OperationsCell({ data }: { data?: QualityControlItem }) {
  if (!data) return null;
  return (
    <div className="flex h-full flex-col justify-center gap-1.5">
      {data.operations.map((operation) => (
        <div key={operation.id} className="flex min-w-0 items-center gap-1.5">
          <Badge variant="outline" className="shrink-0">{operation.operationNumber}</Badge>
          <span className="truncate text-xs" title={`${operation.machine} · ${operation.workType}`}>{operation.machine}</span>
        </div>
      ))}
    </div>
  );
}

function ResultCell({ data }: { data?: QualityControlItem }) {
  if (!data) return null;
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <ResultBadge result={data.result} />
      <div className="text-[11px] leading-4 text-muted-foreground">
        <p>{formatDate(data.reviewedAt)}</p>
        {data.reviewedBy && <p className="truncate" title={data.reviewedBy}>{data.reviewedBy}</p>}
      </div>
    </div>
  );
}

function NotesCell({ data, onChange }: { data?: QualityControlGridRow; onChange: (requirementId: number, value: string) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center py-2">
      <textarea
        aria-label={`Inspection notes for ${data.operations[0].partNumber}`}
        value={data.draftNotes}
        onChange={(event) => onChange(data.requirementId, event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder="Measurements, defects, or acceptance notes…"
        className="h-[104px] w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs leading-5 outline-none focus:border-ring focus:ring-3 focus:ring-ring/50"
      />
    </div>
  );
}

function LocationCell({ data }: { data?: QualityControlItem }) {
  if (!data) return null;
  return (
    <StorageLocationEditor
      requirementId={data.requirementId}
      value={data.storageLocation}
      updatedBy={data.locationUpdatedBy}
      updatedAt={data.locationUpdatedAt}
      canEdit
      compact
      allowOnRobot={canUseOnRobotLocation(data.effectiveQcResult === "passed", data.operations[0].finishingComplete)}
    />
  );
}

function SourceCell({ data }: { data?: QualityControlItem }) {
  if (!data) return null;
  const operation = data.operations[0];
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      <Button size="sm" variant="outline" className="w-full justify-start" nativeButton={!operation.hasDrawingPdf} render={operation.hasDrawingPdf ? <a href={`/api/operations/${operation.id}/files/drawing-pdf`} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.hasDrawingPdf}><FileText /> Drawing PDF</Button>
      <Button size="sm" variant="outline" className="w-full justify-start" nativeButton={!operation.onshapeUrl} render={operation.onshapeUrl ? <a href={operation.onshapeUrl} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.onshapeUrl}><ExternalLink /> Onshape source</Button>
    </div>
  );
}

function ActionCell({
  data,
  reviewPending,
  undoPending,
  onReview,
  onUndo,
}: {
  data?: QualityControlItem;
  reviewPending: boolean;
  undoPending: boolean;
  onReview: (item: QualityControlItem, result: "passed" | "failed") => void;
  onUndo: (item: QualityControlItem) => void;
}) {
  if (!data) return null;
  const ready = data.operations.every((operation) => operation.status === "Complete");
  return (
    <div className="flex h-full flex-col justify-center gap-2">
      {data.result === "pending" ? (
        <>
          <Button size="sm" variant="destructive" onClick={() => onReview(data, "failed")} disabled={reviewPending || !ready}><X /> Fail QC</Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => onReview(data, "passed")} disabled={reviewPending || !ready}>{reviewPending ? <LoaderCircle className="animate-spin" /> : <Check />} Pass QC</Button>
        </>
      ) : data.result === "passed" ? (
        <Button size="sm" variant="outline" onClick={() => onUndo(data)} disabled={undoPending}>{undoPending ? <LoaderCircle className="animate-spin" /> : <Clock3 />} Undo QC pass</Button>
      ) : (
        <p className="text-center text-xs leading-5 text-muted-foreground">Complete the rework to request QC again.</p>
      )}
    </div>
  );
}

export function QualityControlDashboard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["qc"], queryFn: fetchQualityControl });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<"all" | QualityResult>("all");
  const [machine, setMachine] = useState("all");
  const [location, setLocation] = useState("all");

  const invalidateManufacturing = () => {
    queryClient.invalidateQueries({ queryKey: ["qc"] }, { cancelRefetch: false });
    queryClient.invalidateQueries({ queryKey: ["operations"], refetchType: "none" });
    queryClient.invalidateQueries({ queryKey: ["fabrication"], refetchType: "none" });
  };

  const reviewMutation = useMutation({
    mutationFn: ({ item, result: nextResult }: { item: QualityControlItem; result: "passed" | "failed" }) => submitReview(item, nextResult, notes[item.requirementId] ?? item.notes),
    onSuccess: (_data, variables) => {
      toast.success(variables.result === "passed" ? "Quality check passed" : "Operation returned for rework", variables.result === "passed" ? { action: { label: "Undo", onClick: () => undoReviewMutation.mutate(variables.item) } } : undefined);
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to record quality review"),
  });

  const undoReviewMutation = useMutation({
    mutationFn: undoPassedReview,
    onSuccess: () => {
      toast.success("QC pass undone");
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to undo QC pass"),
  });
  const mutateReview = reviewMutation.mutate;
  const reviewIsPending = reviewMutation.isPending;
  const mutateUndoReview = undoReviewMutation.mutate;
  const undoReviewIsPending = undoReviewMutation.isPending;

  const items = useMemo<QualityControlGridRow[]>(() => (query.data?.qualityControl ?? []).map((item) => ({
    ...item,
    draftNotes: notes[item.requirementId] ?? item.notes,
  })), [notes, query.data?.qualityControl]);
  const machines = useMemo(() => [...new Set(items.flatMap((item) => item.operations.map((operation) => operation.machine)))].sort(), [items]);
  const locations = useMemo(() => [...new Set(items.flatMap((item) => item.storageLocation ? [item.storageLocation] : []))].sort(), [items]);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (result !== "all" && item.result !== result) return false;
      if (machine !== "all" && !item.operations.some((operation) => operation.machine === machine)) return false;
      if (location === "unassigned" && item.storageLocation) return false;
      if (location !== "all" && location !== "unassigned" && item.storageLocation !== location) return false;
      if (term && ![
        item.operations[0].partNumber,
        item.operations[0].partName,
        item.operations[0].documentName,
        item.storageLocation,
        item.notes,
        item.draftNotes,
        item.reviewedBy,
        item.result,
        resultLabels[item.result],
        completedBy(item),
        ...item.operations.flatMap((operation) => [operation.operationNumber, operation.machine, operation.workType]),
      ].join(" ").toLocaleLowerCase().includes(term)) return false;
      return true;
    });
  }, [items, location, machine, result, search]);

  const stats = useMemo(() => ({
    pending: items.filter((item) => item.result === "pending").length,
    passed: items.filter((item) => item.result === "passed").length,
    failed: items.filter((item) => item.result === "failed").length,
  }), [items]);

  const updateNotes = useCallback((requirementId: number, value: string) => {
    setNotes((current) => ({ ...current, [requirementId]: value }));
  }, []);
  const columnDefs = useMemo<ColDef<QualityControlGridRow>[]>(() => [
    {
      colId: "part",
      headerName: "PART",
      minWidth: 220,
      pinned: "left",
      valueGetter: ({ data }) => data ? `${data.operations[0].partNumber} ${data.operations[0].partName}` : "",
      cellRenderer: PartCell,
    },
    {
      colId: "operations",
      headerName: "OPERATIONS",
      minWidth: 180,
      valueGetter: ({ data }) => data?.operations.map((operation) => `${operation.operationNumber} ${operation.machine}`).join(" ") ?? "",
      cellRenderer: OperationsCell,
    },
    { colId: "quantity", headerName: "QTY", width: 82, filter: "agNumberColumnFilter", valueGetter: ({ data }) => data?.operations[0].quantity ?? 0 },
    { field: "result", headerName: "QC STATUS", minWidth: 145, cellRenderer: ResultCell },
    {
      field: "notes",
      headerName: "INSPECTION NOTES",
      minWidth: 260,
      flex: 1,
      cellRenderer: NotesCell,
      cellRendererParams: { onChange: updateNotes },
    },
    { field: "storageLocation", headerName: "LOCATION", minWidth: 260, cellRenderer: LocationCell, valueFormatter: ({ value }) => value || "Not recorded" },
    { headerName: "FILES", width: 158, sortable: false, filter: false, cellRenderer: SourceCell },
    {
      headerName: "ACTIONS",
      width: 166,
      pinned: "right",
      sortable: false,
      filter: false,
      resizable: false,
      cellRenderer: ActionCell,
      cellRendererParams: {
        reviewPending: reviewIsPending,
        undoPending: undoReviewIsPending,
        onReview: (item: QualityControlItem, nextResult: "passed" | "failed") => mutateReview({ item, result: nextResult }),
        onUndo: (item: QualityControlItem) => mutateUndoReview(item),
      },
    },
  ], [mutateReview, mutateUndoReview, reviewIsPending, undoReviewIsPending, updateNotes]);

  const clearFilters = () => {
    setSearch("");
    setResult("all");
    setMachine("all");
    setLocation("all");
  };

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,.12)]" /> Administrator workspace</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Quality control</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Inspect completed work, record results, and keep each part’s current location up to date.</p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <ForceQcPicker />
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Awaiting QC", value: stats.pending, icon: ClipboardCheck, tone: "bg-violet-50 text-violet-700" },
              { label: "Passed", value: stats.passed, icon: Check, tone: "bg-emerald-50 text-emerald-700" },
              { label: "Failed", value: stats.failed, icon: X, tone: "bg-rose-50 text-rose-700" },
            ].map(({ label, value, icon: Icon, tone }) => (
              <div key={label} className="flex min-w-28 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm">
                <div className={cn("grid size-8 place-items-center rounded-lg", tone)}><Icon className="size-4" /></div>
                <div><div className="text-lg font-bold leading-none">{value}</div><div className="mt-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
        <div className="border-b bg-muted/25 p-3 md:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="min-w-48 xl:mr-auto">
              <h2 className="font-semibold">Quality control queue</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Review completed production requirements.</p>
            </div>
            <div className="relative min-w-0 flex-1 xl:max-w-md">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-9 bg-card pl-9" placeholder="Search part, operation, machinist, notes…" />
            </div>
            <Select value={result} onValueChange={(value) => setResult((value ?? "all") as "all" | QualityResult)}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-44"><SlidersHorizontal className="text-muted-foreground" /><SelectValue placeholder="All QC statuses" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All QC statuses</SelectItem><SelectItem value="pending">Awaiting QC</SelectItem><SelectItem value="passed">QC passed</SelectItem><SelectItem value="failed">QC failed</SelectItem></SelectContent>
            </Select>
            <Select value={machine} onValueChange={(value) => setMachine(value ?? "all")}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-48"><ClipboardCheck className="text-muted-foreground" /><SelectValue placeholder="All machines" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All machines</SelectItem>{machines.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={location} onValueChange={(value) => setLocation(value ?? "all")}>
              <SelectTrigger className="h-9 w-full bg-card xl:w-48"><MapPin className="text-muted-foreground" /><SelectValue placeholder="All locations" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All locations</SelectItem>{locations.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}<SelectItem value="unassigned">Not recorded</SelectItem></SelectContent>
            </Select>
            <div className="whitespace-nowrap text-xs text-muted-foreground">{filtered.length} of {items.length} shown</div>
          </div>
        </div>

        {query.isPending ? (
          <div className="space-y-3 p-5">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-28 w-full" />)}</div>
        ) : query.isError && !query.data ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><ShieldCheck className="mx-auto mb-3 size-10 text-destructive" /><h2 className="font-semibold">Couldn’t load quality control</h2><p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
        ) : items.length === 0 ? (
          <div className="grid min-h-60 place-items-center p-6 text-center"><div><ClipboardCheck className="mx-auto mb-3 size-10 text-emerald-600" /><h3 className="font-semibold">QC queue is clear</h3><p className="mt-1 text-sm text-muted-foreground">Requirements will appear after all pre-QC manufacturing operations are complete.</p></div></div>
        ) : filtered.length === 0 ? (
          <div className="grid min-h-80 place-items-center p-6 text-center"><div><Search className="mx-auto mb-3 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No QC items match</h2><p className="mt-1 text-sm text-muted-foreground">Try another status, machine, or location, or clear the search.</p><Button variant="outline" className="mt-4" onClick={clearFilters}>Clear filters</Button></div></div>
        ) : (
          <>
            <div className="hidden h-[min(66vh,760px)] min-h-[500px] md:block">
              <AgGridReact<QualityControlGridRow>
                theme={gridTheme}
                rowData={filtered}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, filter: true, resizable: true }}
                getRowId={({ data }) => String(data.requirementId)}
                pagination
                paginationPageSize={10}
                paginationPageSizeSelector={[10, 25, 50]}
                animateRows
              />
            </div>
            <div className="divide-y md:hidden">
              {filtered.map((item) => {
                const operation = item.operations[0];
                return (
                  <article key={item.requirementId} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><p className="font-mono text-xs font-bold text-primary">{operation.partNumber}</p><h3 className="mt-1 truncate font-semibold">{operation.partName}</h3><p className="mt-1 text-xs text-muted-foreground">{item.operations.length} operation{item.operations.length === 1 ? "" : "s"} · Qty {operation.quantity} · {completedBy(item)}</p></div>
                      <ResultBadge result={item.result} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">{item.operations.map((row) => <Badge key={row.id} variant="outline">{row.operationNumber} · {row.machine}</Badge>)}</div>
                    <label className="mt-4 block text-xs font-semibold text-muted-foreground" htmlFor={`qc-notes-${item.requirementId}`}>Inspection notes</label>
                    <textarea id={`qc-notes-${item.requirementId}`} value={item.draftNotes} onChange={(event) => updateNotes(item.requirementId, event.target.value)} placeholder="Measurements, defects, or acceptance notes…" className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50" />
                    <div className="mt-3"><StorageLocationEditor requirementId={item.requirementId} value={item.storageLocation} updatedBy={item.locationUpdatedBy} updatedAt={item.locationUpdatedAt} canEdit allowOnRobot={canUseOnRobotLocation(item.effectiveQcResult === "passed", operation.finishingComplete)} /></div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button variant="outline" nativeButton={!operation.hasDrawingPdf} render={operation.hasDrawingPdf ? <a href={`/api/operations/${operation.id}/files/drawing-pdf`} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.hasDrawingPdf}><FileText /> Drawing PDF</Button>
                      <Button variant="outline" nativeButton={!operation.onshapeUrl} render={operation.onshapeUrl ? <a href={operation.onshapeUrl} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.onshapeUrl}><ExternalLink /> Onshape source</Button>
                      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        {item.result === "pending" ? <><Button variant="destructive" onClick={() => mutateReview({ item, result: "failed" })} disabled={reviewIsPending || !item.operations.every((row) => row.status === "Complete")}><X /> Fail QC</Button><Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => mutateReview({ item, result: "passed" })} disabled={reviewIsPending || !item.operations.every((row) => row.status === "Complete")}>{reviewIsPending ? <LoaderCircle className="animate-spin" /> : <Check />} Pass QC</Button></> : item.result === "passed" ? <Button variant="outline" onClick={() => mutateUndoReview(item)} disabled={undoReviewIsPending}><Clock3 /> Undo QC pass</Button> : <p className="text-xs text-muted-foreground">Complete the rework to request QC again.</p>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
