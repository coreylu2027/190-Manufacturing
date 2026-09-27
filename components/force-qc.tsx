"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { toast } from "sonner";
import { ExpandableText } from "@/components/expandable-text";
import { StorageLocationEditor } from "@/components/storage-location-editor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ManufacturingOperation, OperationsResponse } from "@/lib/types";
import type { createWritePlan } from "@/lib/manufacturing/write-plan";
import { isPostQcOperation } from "@/lib/manufacturing-workflow";
import { settleSequentially } from "@/lib/bulk-selection";

type Preview = Awaited<ReturnType<ReturnType<typeof createWritePlan>["previewForceQuality"]>> & { token: string };
const FINISHING_NOTE = "Finishing marked complete by Admin Force QC.";

function withFinishingNote(notes: string) {
  return [notes.trim(), FINISHING_NOTE].filter(Boolean).join("\n\n");
}

function FinishingToggle({ checked, onChange, disabled, children }: { checked: boolean; onChange: (checked: boolean) => void; disabled: boolean; children: React.ReactNode }) {
  return <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
    <Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={value => onChange(Boolean(value))} />
    <span><span className="font-medium">Also mark finishing complete</span><span className="block text-xs text-muted-foreground">{children}</span></span>
  </label>;
}
type ForceQcButtonProps = Pick<ManufacturingOperation, "storageLocation" | "locationUpdatedBy" | "locationUpdatedAt"> & {
  requirementId: number;
  label: string;
};

export function hasUnfinishedQcPrerequisites(operations: ManufacturingOperation[]) {
  const active = operations.filter(op => op.activeInRouting);
  const preQc = active.filter(op => op.workType === "Manufacturing" && !isPostQcOperation(op, op.qcAfterOperation));
  return preQc.length > 0 && active.some(op => op.status !== "Complete" && (preQc.includes(op)
    || op.workType === "CAM" && preQc.some(target => target.operationNumber === op.operationNumber)));
}

type BulkForceQcRequirement = Pick<ManufacturingOperation, "partNumber" | "obsolete" | "activeInBom" | "effectiveQcResult" | "finishing"> & {
  requirementId: number;
  operations: ManufacturingOperation[];
};

/** Why Force QC can't run on a requirement, or null when it can. Matches the single-part button. */
export function forceQcBlocker(requirement: BulkForceQcRequirement) {
  if (requirement.obsolete) return "obsolete";
  if (!requirement.activeInBom) return "inactive in the BOM";
  if (requirement.effectiveQcResult === "passed") return "QC already passed";
  if (!hasUnfinishedQcPrerequisites(requirement.operations)) return "no unfinished prerequisite work";
  return null;
}

function unfinishedPrerequisiteCount(operations: ManufacturingOperation[]) {
  const active = operations.filter(op => op.activeInRouting);
  const preQc = active.filter(op => op.workType === "Manufacturing" && !isPostQcOperation(op, op.qcAfterOperation));
  return active.filter(op => op.status !== "Complete" && (preQc.includes(op)
    || op.workType === "CAM" && preQc.some(target => target.operationNumber === op.operationNumber))).length;
}

/** Force-completes prerequisite work and records one QC result for each selected requirement, one at a time. */
export function BulkForceQcDialog({ open, onOpenChange, requirements, onFinished }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requirements: BulkForceQcRequirement[];
  onFinished: (succeededIds: number[]) => void;
}) {
  const client = useQueryClient();
  const [notes, setNotes] = useState("");
  const [completeFinishing, setCompleteFinishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const eligible = requirements.filter(requirement => !forceQcBlocker(requirement));
  const finishingCount = eligible.filter(requirement => requirement.finishing && requirement.finishing !== "None").length;
  const skipped = requirements.flatMap(requirement => {
    const reason = forceQcBlocker(requirement);
    return reason ? [`${requirement.partNumber} (${reason})`] : [];
  });
  async function submit(result: "passed" | "failed") {
    setBusy(true); setErrors([]); setProgress(0);
    const extra = notes.trim();
    const results = await settleSequentially(eligible, async (requirement, index) => {
      try {
        const previewResponse = await fetch(`/api/admin/qc/${requirement.requirementId}/force`, { cache: "no-store" });
        const preview = await previewResponse.json();
        if (!previewResponse.ok) throw new Error(preview.error ?? "Unable to preview Force QC");
        const finish = result === "passed" && completeFinishing && preview.nextDestination === "Finishing";
        const inspectionNotes = extra ? `${preview.generatedNotes}\n\n${extra}` : preview.generatedNotes;
        const combined = finish ? withFinishingNote(inspectionNotes) : inspectionNotes;
        if (combined.length > 2000) throw new Error("Inspection notes exceed 2000 characters");
        const response = await fetch(`/api/admin/qc/${requirement.requirementId}/force`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: combined, token: preview.token, result, completeFinishing: finish }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to force QC");
        return requirement.requirementId;
      } catch (error) {
        throw new Error(`${requirement.partNumber}: ${error instanceof Error ? error.message : "Unable to force QC"}`);
      } finally {
        setProgress(index + 1);
      }
    });
    const succeeded = results.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
    const failures = results.flatMap(item => item.status === "rejected" ? [item.reason instanceof Error ? item.reason.message : "Unable to force QC"] : []);
    for (const key of ["production", "operations", "qc", "admin", "fabrication"]) void client.invalidateQueries({ queryKey: [key] });
    setBusy(false);
    onFinished(succeeded);
    const verb = result === "passed" ? "passed" : "failed";
    if (failures.length) {
      setErrors(failures);
      toast.warning(`Force QC ${verb} ${succeeded.length} parts; ${failures.length} failed and remain selected.`);
    } else {
      toast.success(`Force QC ${verb} ${succeeded.length} parts`);
      setNotes("");
      setCompleteFinishing(false);
      onOpenChange(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={value => { if (!busy) { onOpenChange(value); if (!value) setErrors([]); } }}>
      <DialogContent forceBackdrop className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Force QC · {eligible.length} {eligible.length === 1 ? "part" : "parts"}</DialogTitle>
          <DialogDescription>Complete unfinished prerequisites and pass or fail QC for each selected production requirement.</DialogDescription>
        </DialogHeader>
        {eligible.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-3 text-sm">
          {eligible.map(requirement => {
            const count = unfinishedPrerequisiteCount(requirement.operations);
            return <li key={requirement.requirementId} className="flex justify-between gap-3"><span className="truncate font-mono font-semibold">{requirement.partNumber}</span><span className="shrink-0 text-muted-foreground">{count} unfinished {count === 1 ? "task" : "tasks"}</span></li>;
          })}
        </ul>}
        {skipped.length > 0 && <p className="max-h-32 overflow-y-auto text-sm text-muted-foreground">Skipped: {skipped.join("; ")}.</p>}
        {eligible.length === 0 && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">None of the selected parts have unfinished prerequisite work to force-complete.</p>}
        {eligible.length > 0 && <>
          <p className="text-xs text-muted-foreground">Outstanding claims on this work will be cleared. Passing credits newly completed quantities to you and preserves existing completed-work credit. Failing rejects each entire batch and resets pre-QC manufacturing quantities for rework.</p>
          {finishingCount > 0 && <FinishingToggle checked={completeFinishing} onChange={setCompleteFinishing} disabled={busy}>
            On pass, completes powder coating for {finishingCount} {finishingCount === 1 ? "part" : "parts"} and credits you, instead of sending {finishingCount === 1 ? "it" : "them"} to Finishing.
          </FinishingToggle>}
          <label className="text-sm font-medium">Additional inspection notes<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-2 min-h-24 w-full rounded-md border bg-background p-3 font-normal" disabled={busy} placeholder="Optional. Added after each part's generated Force QC note." /></label>
        </>}
        {busy && <p role="status" className="text-sm">Forcing QC… {progress}/{eligible.length}</p>}
        {errors.length > 0 && <ul role="alert" className="max-h-40 space-y-1 overflow-y-auto text-sm text-destructive">{errors.map(message => <li key={message}>{message}</li>)}</ul>}
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="lg" variant="destructive" className="h-11" disabled={busy || !eligible.length || notes.trim().length > 1500 || finishingCount > 0 && completeFinishing} onClick={() => void submit("failed")}>
            <AlertTriangle /> Force complete & fail QC
          </Button>
          <Button size="lg" variant="destructive" className="h-11" disabled={busy || !eligible.length || notes.trim().length > 1500} onClick={() => void submit("passed")}>
            <AlertTriangle /> Force complete & pass QC
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ForceQcButton({ requirementId, label, storageLocation, locationUpdatedBy, locationUpdatedAt }: ForceQcButtonProps) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notes, setNotes] = useState("");
  const [completeFinishing, setCompleteFinishing] = useState(false);
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
  async function submit(result: "passed" | "failed") {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const finish = result === "passed" && finishingPending && completeFinishing;
      const response = await fetch(`/api/admin/qc/${requirementId}/force`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: finish ? withFinishingNote(notes) : notes, token: preview.token, result, completeFinishing: finish }),
      });
      const body = await response.json();
      if (!response.ok) { if (response.status === 409) setStale(true); throw new Error(body.error ?? "Unable to force QC"); }
      toast.success(result === "failed" ? "QC failed · Returned to manufacturing"
        : body.finishingCompleted ? "QC passed · Finishing complete" : `QC passed · ${preview.nextDestination}`);
      setOpen(false);
      for (const key of ["production", "operations", "qc", "admin", "fabrication"]) void client.invalidateQueries({ queryKey: [key] });
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to force QC"); }
    finally { setBusy(false); }
  }
  const finishingPending = preview?.nextDestination === "Finishing";
  const finishing = finishingPending && completeFinishing;
  const notesTooLong = (finishing ? withFinishingNote(notes) : notes.trim()).length > 2000;
  return <>
    <Button
      size="lg"
      variant="destructive"
      className="h-11"
      onClick={() => { setOpen(true); setStale(false); setInitialized(false); setCompleteFinishing(false); void load(); }}
    >
      <AlertTriangle /> Force QC
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent forceBackdrop className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Force QC · {label}</DialogTitle><DialogDescription>Complete unfinished prerequisites and pass or fail QC for the entire production requirement.</DialogDescription></DialogHeader>
        {busy && !preview && <p role="status">Loading affected work…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <StorageLocationEditor
          requirementId={requirementId}
          value={storageLocation}
          updatedBy={locationUpdatedBy}
          updatedAt={locationUpdatedAt}
          canEdit
        />
        {preview && <>
          <p className="text-sm"><ExpandableText text={preview.productionKey} /> · Qty {preview.quantity} · On pass: <strong>{preview.nextDestination}</strong> · On fail: <strong>Return to manufacturing</strong></p>
          <ul className="space-y-2 text-sm">{preview.operations.map(op => <li key={op.id}>{op.operationNumber} · {op.workType} · {op.machine || "CAM"}: {op.previousStatus} → Complete ({op.quantity} {op.workType === "CAM" ? "task(s)" : "part(s)"})</li>)}</ul>
          <p className="text-xs text-muted-foreground">Outstanding claims on this work will be cleared. Passing credits newly completed quantities to you and preserves existing completed-work credit. Failing rejects the entire batch and resets pre-QC manufacturing quantities for rework.</p>
          <label className="text-sm font-medium">Inspection notes<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-2 min-h-40 w-full rounded-md border bg-background p-3 font-normal" disabled={busy} /></label>
          <p className="text-xs text-muted-foreground">{notes.trim().length}/2000 characters. The prefilled note is fully editable.</p>
          {finishingPending && <FinishingToggle checked={completeFinishing} onChange={setCompleteFinishing} disabled={busy}>
            On pass, completes powder coating and credits you, instead of sending the part to Finishing.
          </FinishingToggle>}
        </>}
        <DialogFooter className="sm:flex-wrap">
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          {(stale || !preview && !busy) && <Button variant="outline" disabled={busy} onClick={() => void load(true)}>Refresh preview</Button>}
          <Button
            size="lg"
            variant="destructive"
            className="h-11"
            disabled={busy || !preview || stale || notesTooLong || finishing}
            onClick={() => void submit("failed")}
          >
            <AlertTriangle /> {busy && preview ? "Saving…" : "Force complete & fail QC"}
          </Button>
          <Button
            size="lg"
            variant="destructive"
            className="h-11"
            disabled={busy || !preview || stale || notesTooLong}
            onClick={() => void submit("passed")}
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
    if (operation.requirementId !== null && !operation.obsolete && operation.activeInBom && operation.effectiveQcResult !== "passed") {
      groups.set(operation.requirementId, [...(groups.get(operation.requirementId) ?? []), operation]);
    }
  }
  const candidates = [...groups.entries()].filter(([, operations]) => {
    return hasUnfinishedQcPrerequisites(operations)
      && [operations[0].partNumber, operations[0].partName, operations[0].assemblyNumber, operations[0].requirementKey].join(" ").toLowerCase().includes(search.trim().toLowerCase());
  });
  return <>
    <Button size="lg" variant="destructive" className="h-11" onClick={() => setOpen(true)}>
      <AlertTriangle /> Force QC unfinished part
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[min(42rem,calc(100dvh-2rem))] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Force QC for unfinished parts</DialogTitle>
          <DialogDescription>Select a production requirement whose prerequisite work should be force-completed before passing or failing QC.</DialogDescription>
        </DialogHeader>
        <label className="text-sm font-medium">
          Find a part
          <span className="relative mt-1.5 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input className="block w-full rounded-md border bg-background py-2 pl-9 pr-3 font-normal" value={search} onChange={event => setSearch(event.target.value)} placeholder="Part number, name, assembly, or production key" autoFocus />
          </span>
        </label>
        {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading parts…</p>}
        {query.isError && <p role="alert" className="text-sm text-destructive">Unable to load parts. <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></p>}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {candidates.map(([id, operations]) => <div key={id} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div className="min-w-0 text-sm"><p className="truncate font-semibold">{operations[0].partNumber} · {operations[0].partName}</p><p className="text-xs text-muted-foreground"><ExpandableText text={operations[0].requirementKey ?? "Not synced"} maxLength={80} /> · Qty {operations[0].quantity}</p></div><ForceQcButton requirementId={id} label={operations[0].partNumber} storageLocation={operations[0].storageLocation} locationUpdatedBy={operations[0].locationUpdatedBy} locationUpdatedAt={operations[0].locationUpdatedAt} /></div>)}
          {!query.isLoading && !query.isError && !candidates.length && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No matching unfinished parts.</p>}
        </div>
        <DialogFooter className="sm:flex-wrap"><Button variant="outline" onClick={() => setOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
