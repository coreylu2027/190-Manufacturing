"use client";

import { ForceQcPicker } from "@/components/force-qc";

import { themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  MapPin,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { StorageLocationEditor } from "@/components/storage-location-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  rowHeight: 82,
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

async function updateInspectionNotes(item: QualityControlItem, notes: string): Promise<{ review: { notes: string; reviewedAt: string; reviewedBy: string } }> {
  const response = await fetch(`/api/admin/qc/${item.requirementId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to update inspection notes");
  return body;
}

async function deleteProductionNotes(item: QualityControlItem): Promise<{ productionNotes: string }> {
  const response = await fetch(`/api/requirements/${item.requirementId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: "" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to delete production notes");
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

function NotesCell({ value }: { value: string }) {
  const notes = value || "No inspection notes";
  return <div className="flex h-full min-w-0 items-center"><span className={cn("truncate", !value && "text-muted-foreground")} title={notes}>{notes}</span></div>;
}

function ActionCell({ data, onOpen }: { data?: QualityControlItem; onOpen: (item: QualityControlItem) => void }) {
  if (!data) return null;
  return (
    <div className="flex h-full items-center justify-end">
      <Button size="sm" variant={data.result === "pending" ? "default" : "outline"} onClick={() => onOpen(data)}>
        {data.result === "pending" ? "Review" : "Open"}<ChevronRight />
      </Button>
    </div>
  );
}

function ProductionNotesForQc({
  item,
  deleting,
  onDelete,
}: {
  item: QualityControlItem;
  deleting: boolean;
  onDelete: (item: QualityControlItem) => void;
}) {
  return (
    <div className="mt-4 border-t border-dashed pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Production note</p>
          <p className="mt-1 text-xs text-muted-foreground">Carried with this production requirement.</p>
        </div>
        {item.productionNotes && (
          <Button size="sm" variant="outline" onClick={() => onDelete(item)} disabled={deleting}>
            {deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />} Delete
          </Button>
        )}
      </div>
      <p className={cn("mt-3 whitespace-pre-wrap rounded-xl border p-3 text-sm leading-6", item.productionNotes ? "bg-muted/20 text-foreground" : "border-dashed bg-muted/10 text-muted-foreground")}>
        {item.productionNotes || "No production notes remain."}
      </p>
    </div>
  );
}

export function QualityControlDashboard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["qc"], queryFn: fetchQualityControl });
  const [draftNotes, setDraftNotes] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<"all" | QualityResult>("all");
  const [machine, setMachine] = useState("all");
  const [location, setLocation] = useState("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const invalidateManufacturing = () => {
    queryClient.invalidateQueries({ queryKey: ["qc"] }, { cancelRefetch: false });
    queryClient.invalidateQueries({ queryKey: ["operations"], refetchType: "none" });
    queryClient.invalidateQueries({ queryKey: ["fabrication"], refetchType: "none" });
  };

  const reviewMutation = useMutation({
    mutationFn: ({ item, result: nextResult, notes }: { item: QualityControlItem; result: "passed" | "failed"; notes: string }) => submitReview(item, nextResult, notes),
    onSuccess: (_data, variables) => {
      toast.success(variables.result === "passed" ? "Quality check passed" : "Operation returned for rework", variables.result === "passed" ? { action: { label: "Undo", onClick: () => undoReviewMutation.mutate(variables.item) } } : undefined);
      setSelectedId(null);
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to record quality review"),
  });

  const undoReviewMutation = useMutation({
    mutationFn: undoPassedReview,
    onSuccess: () => {
      toast.success("QC pass undone");
      setSelectedId(null);
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to undo QC pass"),
  });
  const updateNotesMutation = useMutation({
    mutationFn: ({ item, notes }: { item: QualityControlItem; notes: string }) => updateInspectionNotes(item, notes),
    onSuccess: ({ review }, variables) => {
      queryClient.setQueryData<AdminResponse>(["qc"], (current) => current ? {
        ...current,
        qualityControl: current.qualityControl.map((item) => item.requirementId === variables.item.requirementId ? {
          ...item,
          notes: review.notes,
          reviewedAt: review.reviewedAt,
          reviewedBy: review.reviewedBy,
        } : item),
      } : current);
      setDraftNotes((current) => {
        const next = { ...current };
        delete next[variables.item.requirementId];
        return next;
      });
      toast.success("Inspection notes updated");
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update inspection notes"),
  });
  const deleteProductionNotesMutation = useMutation({
    mutationFn: deleteProductionNotes,
    onSuccess: (_result, variables) => {
      queryClient.setQueryData<AdminResponse>(["qc"], (current) => current ? {
        ...current,
        qualityControl: current.qualityControl.map((item) => item.requirementId === variables.requirementId
          ? { ...item, productionNotes: "" }
          : item),
      } : current);
      toast.success("Production note deleted");
      invalidateManufacturing();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete production notes"),
  });
  const mutateReview = reviewMutation.mutate;
  const reviewIsPending = reviewMutation.isPending;
  const mutateUndoReview = undoReviewMutation.mutate;
  const undoReviewIsPending = undoReviewMutation.isPending;
  const mutateNotes = updateNotesMutation.mutate;
  const notesArePending = updateNotesMutation.isPending;
  const productionNotesAreDeleting = deleteProductionNotesMutation.isPending;

  const items = useMemo(() => query.data?.qualityControl ?? [], [query.data?.qualityControl]);
  const machines = useMemo(() => [...new Set(items.flatMap((item) => item.operations.map((operation) => operation.machine)))].sort(), [items]);
  const locations = useMemo(() => [...new Set(items.flatMap((item) => item.storageLocation ? [item.storageLocation] : []))].sort(), [items]);
  const selected = selectedId === null ? null : items.find((item) => item.requirementId === selectedId) ?? null;
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
        item.productionNotes,
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
    setDraftNotes((current) => ({ ...current, [requirementId]: value }));
  }, []);
  const openItem = (item: QualityControlItem) => setSelectedId(item.requirementId);
  const columnDefs = useMemo<ColDef<QualityControlItem>[]>(() => [
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
    },
    {
      field: "storageLocation",
      headerName: "LOCATION",
      minWidth: 175,
      valueFormatter: ({ value }) => value || "Not recorded",
    },
    {
      headerName: "",
      width: 106,
      pinned: "right",
      sortable: false,
      filter: false,
      resizable: false,
      cellRenderer: ActionCell,
      cellRendererParams: { onOpen: openItem },
    },
  ], []);

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
              <AgGridReact<QualityControlItem>
                theme={gridTheme}
                rowData={filtered}
                columnDefs={columnDefs}
                defaultColDef={{ sortable: true, filter: true, resizable: true }}
                getRowId={({ data }) => String(data.requirementId)}
                onRowDoubleClicked={({ data }) => data && openItem(data)}
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
                    <textarea
                      id={`qc-notes-${item.requirementId}`}
                      aria-label={`Inspection notes for ${item.operations[0].partNumber}`}
                      value={draftNotes[item.requirementId] ?? item.notes}
                      onChange={(event) => updateNotes(item.requirementId, event.currentTarget.value)}
                      maxLength={2000}
                      disabled={item.result === "failed" || notesArePending}
                      placeholder="Measurements, defects, or acceptance notes…"
                      className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground caret-foreground outline-none focus:border-ring focus:ring-3 focus:ring-ring/50"
                    />
                    <ProductionNotesForQc
                      item={item}
                      deleting={productionNotesAreDeleting}
                      onDelete={deleteProductionNotesMutation.mutate}
                    />
                    <div className="mt-3"><StorageLocationEditor requirementId={item.requirementId} value={item.storageLocation} updatedBy={item.locationUpdatedBy} updatedAt={item.locationUpdatedAt} canEdit allowOnRobot={canUseOnRobotLocation(item.effectiveQcResult === "passed", operation.finishingComplete)} /></div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button variant="outline" nativeButton={!operation.hasDrawingPdf} render={operation.hasDrawingPdf ? <a href={`/api/operations/${operation.id}/files/drawing-pdf`} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.hasDrawingPdf}><FileText /> Drawing PDF</Button>
                      <Button variant="outline" nativeButton={!operation.onshapeUrl} render={operation.onshapeUrl ? <a href={operation.onshapeUrl} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.onshapeUrl}><ExternalLink /> Onshape source</Button>
                      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        {item.result === "pending" ? <><Button variant="destructive" onClick={() => mutateReview({ item, result: "failed", notes: draftNotes[item.requirementId] ?? item.notes })} disabled={reviewIsPending || !item.operations.every((row) => row.status === "Complete")}><X /> Fail QC</Button><Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => mutateReview({ item, result: "passed", notes: draftNotes[item.requirementId] ?? item.notes })} disabled={reviewIsPending || !item.operations.every((row) => row.status === "Complete")}>{reviewIsPending ? <LoaderCircle className="animate-spin" /> : <Check />} Pass QC</Button></> : item.result === "passed" ? <><Button onClick={() => mutateNotes({ item, notes: draftNotes[item.requirementId] ?? item.notes })} disabled={notesArePending || draftNotes[item.requirementId] === undefined || draftNotes[item.requirementId] === item.notes}>{notesArePending ? <LoaderCircle className="animate-spin" /> : <Save />} Save note</Button><Button variant="outline" onClick={() => mutateUndoReview(item)} disabled={undoReviewIsPending || notesArePending}><Clock3 /> Undo QC pass</Button></> : <p className="text-xs text-muted-foreground">Complete the rework to request QC again.</p>}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (() => {
            const operation = selected.operations[0];
            const ready = selected.operations.every((item) => item.status === "Complete");
            return <>
              <SheetHeader className="border-b p-6 pr-14">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <ResultBadge result={selected.result} />
                  <Badge variant="outline">Qty {operation.quantity}</Badge>
                </div>
                <SheetTitle className="text-2xl font-bold tracking-tight">{operation.partName}</SheetTitle>
                <SheetDescription className="font-mono text-xs font-semibold text-primary">{operation.partNumber}</SheetDescription>
              </SheetHeader>

              <div className="space-y-6 p-6">
                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Operations</h3>
                  <div className="grid gap-2">
                    {selected.operations.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-xl border p-3"><Badge variant="outline">{item.operationNumber}</Badge><div className="min-w-0"><p className="truncate text-sm font-semibold">{item.machine}</p><p className="text-xs text-muted-foreground">{item.workType} · {item.status}</p></div></div>)}
                  </div>
                </section>

                <section>
                  <label className="mb-3 block text-xs font-bold uppercase tracking-[.14em] text-muted-foreground" htmlFor={`qc-review-notes-${selected.requirementId}`}>Inspection notes</label>
                  <textarea
                    id={`qc-review-notes-${selected.requirementId}`}
                    value={draftNotes[selected.requirementId] ?? selected.notes}
                    onChange={(event) => updateNotes(selected.requirementId, event.currentTarget.value)}
                    maxLength={2000}
                    disabled={selected.result === "failed" || reviewIsPending || notesArePending}
                    placeholder="Measurements, defects, or acceptance notes…"
                    className="min-h-36 w-full resize-y rounded-xl border border-input bg-background px-4 py-3 text-sm leading-6 text-foreground caret-foreground outline-none disabled:opacity-70 focus:border-ring focus:ring-3 focus:ring-ring/50"
                  />
                  <ProductionNotesForQc
                    item={selected}
                    deleting={productionNotesAreDeleting}
                    onDelete={deleteProductionNotesMutation.mutate}
                  />
                  {selected.reviewedAt && <p className="mt-2 text-xs text-muted-foreground">Reviewed {formatDate(selected.reviewedAt)}{selected.reviewedBy ? ` by ${selected.reviewedBy}` : ""}</p>}
                </section>

                <section>
                  <StorageLocationEditor
                    requirementId={selected.requirementId}
                    value={selected.storageLocation}
                    updatedBy={selected.locationUpdatedBy}
                    updatedAt={selected.locationUpdatedAt}
                    canEdit
                    allowOnRobot={canUseOnRobotLocation(selected.effectiveQcResult === "passed", operation.finishingComplete)}
                  />
                </section>

                <section>
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Files & source</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button variant="outline" className="h-11 justify-start" nativeButton={!operation.hasDrawingPdf} render={operation.hasDrawingPdf ? <a href={`/api/operations/${operation.id}/files/drawing-pdf`} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.hasDrawingPdf}><FileText /> Drawing PDF</Button>
                    <Button variant="outline" className="h-11 justify-start" nativeButton={!operation.onshapeUrl} render={operation.onshapeUrl ? <a href={operation.onshapeUrl} target="_blank" rel="noreferrer" /> : undefined} disabled={!operation.onshapeUrl}><ExternalLink /> Onshape source</Button>
                  </div>
                </section>
              </div>

              <SheetFooter className="sticky bottom-0 border-t bg-card/95 p-4 backdrop-blur">
                {selected.result === "pending" ? <>
                  <Button size="lg" variant="destructive" className="h-11" onClick={() => mutateReview({ item: selected, result: "failed", notes: draftNotes[selected.requirementId] ?? selected.notes })} disabled={reviewIsPending || !ready}><X /> Fail QC</Button>
                  <Button size="lg" className="h-11 bg-emerald-600 hover:bg-emerald-700" onClick={() => mutateReview({ item: selected, result: "passed", notes: draftNotes[selected.requirementId] ?? selected.notes })} disabled={reviewIsPending || !ready}>{reviewIsPending ? <LoaderCircle className="animate-spin" /> : <Check />} Pass QC</Button>
                </> : selected.result === "passed" ? (
                  <>
                    <Button size="lg" className="h-11" onClick={() => mutateNotes({ item: selected, notes: draftNotes[selected.requirementId] ?? selected.notes })} disabled={notesArePending || draftNotes[selected.requirementId] === undefined || draftNotes[selected.requirementId] === selected.notes}>{notesArePending ? <LoaderCircle className="animate-spin" /> : <Save />} Save note</Button>
                    <Button size="lg" variant="outline" className="h-11" onClick={() => mutateUndoReview(selected)} disabled={undoReviewIsPending || notesArePending}>{undoReviewIsPending ? <LoaderCircle className="animate-spin" /> : <Clock3 />} Undo QC pass</Button>
                  </>
                ) : (
                  <div className="rounded-xl bg-rose-50 p-3 text-center text-sm font-medium text-rose-800">Complete the rework to request QC again.</div>
                )}
                <Button variant="outline" onClick={() => setSelectedId(null)}>Close</Button>
              </SheetFooter>
            </>;
          })()}
        </SheetContent>
      </Sheet>
    </section>
  );
}
