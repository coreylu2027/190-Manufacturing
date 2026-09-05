"use client";
import { ForceQcPicker } from "@/components/force-qc";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardCheck, Clock3, ExternalLink, FileText, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { StorageLocationEditor } from "@/components/storage-location-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { canUseOnRobotLocation } from "@/lib/storage-locations";
import type { AdminResponse, QualityControlItem } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function QualityControlDashboard() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["qc"], queryFn: fetchQualityControl });
  const [notes, setNotes] = useState<Record<number, string>>({});

  const reviewMutation = useMutation({
    mutationFn: ({ item, result }: { item: QualityControlItem; result: "passed" | "failed" }) => submitReview(item, result, notes[item.requirementId] ?? item.notes),
    onSuccess: (_data, variables) => {
      toast.success(variables.result === "passed" ? "Quality check passed" : "Operation returned for rework", variables.result === "passed" ? { action: { label: "Undo", onClick: () => undoReviewMutation.mutate(variables.item) } } : undefined);
      queryClient.invalidateQueries({ queryKey: ["qc"] });
      queryClient.invalidateQueries({ queryKey: ["operations"] });
      queryClient.invalidateQueries({ queryKey: ["fabrication"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to record quality review"),
  });

  const undoReviewMutation = useMutation({
    mutationFn: undoPassedReview,
    onSuccess: () => {
      toast.success("QC pass undone");
      queryClient.invalidateQueries({ queryKey: ["qc"] });
      queryClient.invalidateQueries({ queryKey: ["operations"] });
      queryClient.invalidateQueries({ queryKey: ["fabrication"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to undo QC pass"),
  });

  const stats = useMemo(() => ({
    pending: query.data?.qualityControl.filter((item) => item.result === "pending").length ?? 0,
    passed: query.data?.qualityControl.filter((item) => item.result === "passed").length ?? 0,
    failed: query.data?.qualityControl.filter((item) => item.result === "failed").length ?? 0,
  }), [query.data]);

  return (
    <section className="mx-auto max-w-[1800px] px-4 py-5 md:px-7 md:py-7">
      <ForceQcPicker />
      <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary"><span className="size-2 rounded-full bg-violet-500 shadow-[0_0_0_4px_rgba(139,92,246,.12)]" /> Administrator workspace</div>
          <h1 className="text-3xl font-bold tracking-[-.035em] md:text-[2.55rem]">Quality control</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Inspect completed work, record results, and keep each part’s current location up to date.</p>
        </div>
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

      {query.isLoading ? (
        <Skeleton className="h-[520px] rounded-2xl" />
      ) : query.isError ? (
        <div className="grid min-h-80 place-items-center rounded-2xl border bg-card p-6 text-center"><div><ShieldCheck className="mx-auto mb-3 size-10 text-destructive" /><h2 className="font-semibold">Couldn’t load quality control</h2><p className="mt-1 text-sm text-muted-foreground">{query.error.message}</p><Button className="mt-4" onClick={() => query.refetch()}>Try again</Button></div></div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_14px_42px_rgba(15,23,42,.055)]">
          <div className="border-b bg-muted/25 px-4 py-3"><h2 className="font-semibold">Quality control queue</h2><p className="mt-0.5 text-xs text-muted-foreground">Production requirements appear after every pre-QC manufacturing operation is complete.</p></div>
          {query.data?.qualityControl.length ? (
            <div className="divide-y">
              {query.data.qualityControl.map((item) => (
                <article key={item.requirementId} className="p-4 md:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-bold text-primary">{item.operations[0].partNumber}</span>{item.operations.map((operation) => <Badge key={operation.id} variant="outline">{operation.operationNumber}</Badge>)}<Badge variant="outline" className={cn(item.result === "passed" && "border-emerald-200 bg-emerald-50 text-emerald-800", item.result === "failed" && "border-rose-200 bg-rose-50 text-rose-800", item.result === "pending" && "border-amber-200 bg-amber-50 text-amber-800")}>{item.result === "pending" ? "Awaiting QC" : item.result === "passed" ? "QC passed" : "QC failed"}</Badge></div><h3 className="mt-2 font-semibold">{item.operations[0].partName}</h3><p className="mt-1 text-xs text-muted-foreground">{item.operations.length} operation{item.operations.length === 1 ? "" : "s"} complete · Qty {item.operations[0].quantity} · Completed by {[...new Set(item.operations.flatMap((operation) => operation.allocations.filter((allocation) => allocation.completed > 0).map((allocation) => allocation.name)))].join(", ") || "machinist"}</p></div>
                    {item.reviewedAt && <p className="shrink-0 text-xs text-muted-foreground">{formatDate(item.reviewedAt)}<br />{item.reviewedBy}</p>}
                  </div>
                  <label className="mt-4 block text-xs font-semibold text-muted-foreground" htmlFor={`qc-notes-${item.requirementId}`}>Inspection notes</label>
                  <textarea id={`qc-notes-${item.requirementId}`} value={notes[item.requirementId] ?? item.notes} onChange={(event) => setNotes((current) => ({ ...current, [item.requirementId]: event.target.value }))} placeholder="Measurements, defects, or acceptance notes…" className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50" />
                  <div className="mt-3">
                    <StorageLocationEditor
                      requirementId={item.requirementId}
                      value={item.storageLocation}
                      updatedBy={item.locationUpdatedBy}
                      updatedAt={item.locationUpdatedAt}
                      canEdit
                      allowOnRobot={canUseOnRobotLocation(item.effectiveQcResult === "passed", item.operations[0].finishingComplete)}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="outline" nativeButton={!item.operations[0].hasDrawingPdf} render={item.operations[0].hasDrawingPdf ? <a href={`/api/operations/${item.operations[0].id}/files/drawing-pdf`} target="_blank" rel="noreferrer" /> : undefined} disabled={!item.operations[0].hasDrawingPdf}><FileText /> Drawing PDF</Button>
                    <Button variant="outline" nativeButton={!item.operations[0].onshapeUrl} render={item.operations[0].onshapeUrl ? <a href={item.operations[0].onshapeUrl} target="_blank" rel="noreferrer" /> : undefined} disabled={!item.operations[0].onshapeUrl}><ExternalLink /> Onshape source</Button>
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{item.result === "pending" ? <><Button variant="destructive" onClick={() => reviewMutation.mutate({ item, result: "failed" })} disabled={reviewMutation.isPending || !item.operations.every((operation) => operation.status === "Complete")}><X /> Fail QC</Button><Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => reviewMutation.mutate({ item, result: "passed" })} disabled={reviewMutation.isPending || !item.operations.every((operation) => operation.status === "Complete")}>{reviewMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Pass QC</Button></> : item.result === "passed" ? <Button variant="outline" onClick={() => undoReviewMutation.mutate(item)} disabled={undoReviewMutation.isPending}><Clock3 /> Undo QC pass</Button> : <p className="text-xs text-muted-foreground">Complete the rework to request QC again.</p>}</div>
                  </div>
                </article>
              ))}
            </div>
          ) : <div className="grid min-h-60 place-items-center p-6 text-center"><div><ClipboardCheck className="mx-auto mb-3 size-10 text-emerald-600" /><h3 className="font-semibold">QC queue is clear</h3><p className="mt-1 text-sm text-muted-foreground">Requirements will appear after all pre-QC manufacturing operations are complete.</p></div></div>}
        </div>
      )}
    </section>
  );
}
