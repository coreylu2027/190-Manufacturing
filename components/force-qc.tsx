"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ManufacturingOperation, OperationsResponse } from "@/lib/types";
import type { createWritePlan } from "@/lib/manufacturing/write-plan";
import { requiresPassedQc } from "@/lib/manufacturing-workflow";

type Preview = Awaited<ReturnType<ReturnType<typeof createWritePlan>["previewForceQuality"]>> & { token: string };

export function hasUnfinishedQcPrerequisites(operations: ManufacturingOperation[]) {
  const active = operations.filter(op => op.activeInRouting);
  const preQc = active.filter(op => op.workType === "Manufacturing" && !requiresPassedQc(op.machine));
  return preQc.length > 0 && active.some(op => op.status !== "Complete" && (preQc.includes(op)
    || op.workType === "CAM" && preQc.some(target => target.operationNumber === op.operationNumber)));
}

export function ForceQcButton({ requirementId, label }: { requirementId: number; label: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [initialized, setInitialized] = useState(false);
  async function load(preserveNotes = false) {
    setBusy(true); setError(""); setPreview(null);
    try {
      const response = await fetch(`/api/admin/qc/${requirementId}/force`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to preview Force QC");
      setPreview(body); setStale(false);
      if (!preserveNotes || !initialized) setNotes(body.generatedNotes);
      setInitialized(true);
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to preview Force QC"); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/qc/${requirementId}/force`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, token: preview.token }),
      });
      const body = await response.json();
      if (!response.ok) { if (response.status === 409) setStale(true); throw new Error(body.error ?? "Unable to force QC"); }
      toast.success(`QC passed · ${preview.nextDestination}`);
      setOpen(false);
      for (const key of ["production", "operations", "qc", "admin", "fabrication"]) void client.invalidateQueries({ queryKey: [key] });
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to force QC"); }
    finally { setBusy(false); }
  }
  return <>
    <Button variant="outline" onClick={() => { setOpen(true); setStale(false); setInitialized(false); void load(); }}>Force QC</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Force QC · {label}</DialogTitle><DialogDescription>Complete unfinished prerequisites and pass QC for the entire production requirement.</DialogDescription></DialogHeader>
        {busy && !preview && <p role="status">Loading affected work…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {preview && <>
          <p className="text-sm">{preview.productionKey} · Qty {preview.quantity} · Next: <strong>{preview.nextDestination}</strong></p>
          <ul className="space-y-2 text-sm">{preview.operations.map(op => <li key={op.id}>{op.operationNumber} · {op.workType} · {op.machine || "CAM"}: {op.previousStatus} → Complete ({op.quantity} {op.workType === "CAM" ? "task(s)" : "part(s)"})</li>)}</ul>
          <p className="text-xs text-muted-foreground">Outstanding claims on this work will be cleared. Newly completed quantities will be credited to you; existing completed-work credit is preserved.</p>
          <label className="text-sm font-medium">Inspection notes<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-2 min-h-40 w-full rounded-md border bg-background p-3 font-normal" disabled={busy} /></label>
          <p className="text-xs text-muted-foreground">{notes.trim().length}/2000 characters. The prefilled note is fully editable.</p>
        </>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          {(stale || !preview && !busy) && <Button variant="outline" disabled={busy} onClick={() => void load(true)}>Refresh preview</Button>}
          <Button disabled={busy || !preview || stale || notes.trim().length > 2000} onClick={() => void submit()}>{busy && preview ? "Saving…" : "Force complete & pass QC"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function ForceQcPicker() {
  const [search, setSearch] = useState("");
  const query = useQuery<OperationsResponse>({ queryKey: ["operations"], queryFn: async () => {
    const response = await fetch("/api/operations", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Unable to load parts");
    return body;
  } });
  const groups = new Map<number, OperationsResponse["operations"]>();
  for (const operation of query.data?.operations ?? []) {
    if (operation.requirementId !== null && operation.activeInBom && operation.effectiveQcResult !== "passed") {
      groups.set(operation.requirementId, [...(groups.get(operation.requirementId) ?? []), operation]);
    }
  }
  const candidates = [...groups.entries()].filter(([, operations]) => {
    return hasUnfinishedQcPrerequisites(operations)
      && [operations[0].partNumber, operations[0].partName, operations[0].requirementKey].join(" ").toLowerCase().includes(search.toLowerCase());
  });
  return <details className="mb-5 rounded-xl border bg-card p-4">
    <summary className="cursor-pointer font-semibold">Force QC for unfinished parts</summary>
    <label className="mt-3 block text-sm">Find a part<input className="mt-1 block w-full rounded-md border bg-background p-2" value={search} onChange={event => setSearch(event.target.value)} placeholder="Part number, name, or production key" /></label>
    {query.isLoading && <p role="status">Loading parts…</p>}
    {query.isError && <p role="alert">Unable to load parts. <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></p>}
    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{candidates.map(([id, operations]) => <div key={id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div className="text-sm">{operations[0].partNumber} · {operations[0].partName}<p className="text-xs text-muted-foreground">{operations[0].requirementKey} · Qty {operations[0].quantity}</p></div><ForceQcButton requirementId={id} label={operations[0].partNumber} /></div>)}</div>
    {!query.isLoading && !query.isError && !candidates.length && <p className="mt-3 text-sm text-muted-foreground">No matching unfinished parts.</p>}
  </details>;
}
