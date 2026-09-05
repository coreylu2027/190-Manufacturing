"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
    <Button
      variant="destructive"
      className="border border-destructive/30 bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 dark:bg-destructive dark:text-destructive-foreground dark:hover:bg-destructive/90"
      onClick={() => { setOpen(true); setStale(false); setInitialized(false); void load(); }}
    >
      <AlertTriangle /> Force QC
    </Button>
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
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          {(stale || !preview && !busy) && <Button variant="outline" disabled={busy} onClick={() => void load(true)}>Refresh preview</Button>}
          <Button
            variant="destructive"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive dark:text-destructive-foreground dark:hover:bg-destructive/90"
            disabled={busy || !preview || stale || notes.trim().length > 2000}
            onClick={() => void submit()}
          >
            <AlertTriangle /> {busy && preview ? "Saving…" : "Force complete & pass QC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

export function ForceQcPicker() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
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
  return <>
    <Button variant="destructive" className="border border-destructive/25" onClick={() => setOpen(true)}>
      <AlertTriangle /> Force QC unfinished part
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Force QC for unfinished parts</DialogTitle>
          <DialogDescription>Select a production requirement whose prerequisite work should be force-completed before QC passes.</DialogDescription>
        </DialogHeader>
        <label className="text-sm font-medium">
          Find a part
          <span className="relative mt-1.5 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input className="block w-full rounded-md border bg-background py-2 pl-9 pr-3 font-normal" value={search} onChange={event => setSearch(event.target.value)} placeholder="Part number, name, or production key" autoFocus />
          </span>
        </label>
        {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading parts…</p>}
        {query.isError && <p role="alert" className="text-sm text-destructive">Unable to load parts. <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></p>}
        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">{candidates.map(([id, operations]) => <div key={id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0 text-sm"><p className="truncate font-semibold">{operations[0].partNumber} · {operations[0].partName}</p><p className="truncate text-xs text-muted-foreground">{operations[0].requirementKey} · Qty {operations[0].quantity}</p></div><ForceQcButton requirementId={id} label={operations[0].partNumber} /></div>)}</div>
        {!query.isLoading && !query.isError && !candidates.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No matching unfinished parts.</p>}
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
