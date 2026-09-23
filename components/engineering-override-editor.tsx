"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Download, LoaderCircle, PencilLine, RotateCcw, ShoppingCart, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CORRECTION_FIELD_LABELS, FINISH_COLORS, MACHINE_NAMES, MAX_DESCRIPTION_LENGTH, MAX_MATERIAL_LENGTH, MAX_NAME_LENGTH,
  MAX_OVERRIDE_FILE_BYTES, MAX_OVERRIDE_REASON_LENGTH, ROUTING_FIELDS, normalizeFinishColor, routingError,
  type EngineeringOverrideFields, type EngineeringOverrideRow, type EngineeringOverrideState, type FinishColor, type OverrideField,
  type OverrideFileKind, type Routing,
} from "@/lib/engineering-overrides";
import { createClient } from "@/lib/supabase/client";

const NO_MACHINE = "__none";
const MANUFACTURING_QUERY_KEYS = ["operations", "cam", "fabrication", "qc", "admin", "engineering-corrections"] as const;
const FILE_KINDS: Array<{ kind: OverrideFileKind; label: string; accept: string; icon: typeof FileText }> = [
  { kind: "drawing-pdf", label: "Drawing PDF", accept: ".pdf,application/pdf", icon: FileText },
  { kind: "step", label: "STEP file", accept: ".step,.stp", icon: Download },
];
const TEXTAREA_CLASS = "mt-1.5 w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-70";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? "Request failed"), { status: response.status });
  return body as T;
}

const display = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);
const formatDate = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function overrideFor(state: EngineeringOverrideState, field: OverrideField) {
  return state.overrides.find((row) => row.field === field) ?? null;
}

function OverrideMeta({ override, onRevert, disabled }: { override: EngineeringOverrideRow | null; onRevert?: () => void; disabled?: boolean }) {
  if (!override) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>Onshape: <span className="font-semibold text-foreground">{display(override.synced_value)}</span></span>
      <span>· Adjusted by {override.updated_by_name} · {formatDate(override.updated_at)}</span>
      {onRevert && <button type="button" disabled={disabled} onClick={onRevert} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-50"><RotateCcw className="size-3" />Use Onshape value</button>}
    </div>
  );
}

function MachineSelect({ value, onChange, disabled, label }: { value: string | null; onChange: (value: string | null) => void; disabled?: boolean; label: string }) {
  return (
    <Select value={value ?? NO_MACHINE} onValueChange={(next) => onChange(next === NO_MACHINE || next === null ? null : String(next))} disabled={disabled}>
      <SelectTrigger aria-label={label} className="h-9 w-full bg-background"><SelectValue>{value ?? "No operation"}</SelectValue></SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={NO_MACHINE}>No operation</SelectItem>
        {MACHINE_NAMES.map((machine) => <SelectItem key={machine} value={machine}>{machine}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

interface Draft {
  quantity: string; name: string; description: string; material: string; finishing: FinishColor; routing: Routing;
  offTheShelf: boolean; reason: string;
}

function draftFrom(state: EngineeringOverrideState): Draft {
  const requirement = state.requirement!;
  return {
    quantity: String(Number(requirement.required_quantity ?? 0)),
    name: state.part?.name ?? "",
    description: state.part?.description ?? "",
    material: state.part?.material ?? "",
    finishing: normalizeFinishColor(requirement.finishing),
    routing: ROUTING_FIELDS.map((field) => requirement[field] || null) as Routing,
    offTheShelf: requirement.off_the_shelf,
    reason: "",
  };
}

function changedFields(state: EngineeringOverrideState, draft: Draft): EngineeringOverrideFields {
  const initial = draftFrom(state);
  const fields: EngineeringOverrideFields = {};
  if (draft.quantity.trim() !== initial.quantity) fields.quantity = { value: Number(draft.quantity) };
  if (draft.name.trim() !== initial.name.trim()) fields.name = { value: draft.name.trim() };
  if (draft.description.trim() !== initial.description.trim()) fields.description = { value: draft.description.trim() || null };
  if (draft.material.trim() !== initial.material.trim()) fields.material = { value: draft.material.trim() || null };
  if (draft.finishing !== initial.finishing) fields.finishing = { value: draft.finishing };
  if (JSON.stringify(draft.routing) !== JSON.stringify(initial.routing)) fields.routing = { value: draft.routing };
  if (draft.offTheShelf !== initial.offTheShelf) fields.offTheShelf = { value: draft.offTheShelf };
  return fields;
}

/** Admin-only summary and editor for correcting data delivered by the Onshape sync. */
export function EngineeringOverrides({ requirementId, partNumber, obsolete, activeInBom, compact = false }: {
  requirementId: number;
  partNumber: string;
  obsolete: boolean;
  activeInBom: boolean;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<OverrideFileKind | null>(null);
  const fileInputs = useRef<Partial<Record<OverrideFileKind, HTMLInputElement | null>>>({});
  const queryKey = ["engineering-overrides", requirementId];
  const query = useQuery({
    queryKey,
    queryFn: () => requestJson<EngineeringOverrideState>(`/api/requirements/${requirementId}/engineering`),
  });
  const state = query.data;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      ...MANUFACTURING_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
    ]);
  }
  function handleConflict(caught: unknown) {
    const message = caught instanceof Error ? caught.message : "Unable to save";
    setError(message);
    if ((caught as { status?: number }).status === 409) void queryClient.invalidateQueries({ queryKey });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!state || !draft) throw new Error("Engineering data is still loading");
      const fields = changedFields(state, draft);
      if (!Object.keys(fields).length) throw new Error("Nothing to change");
      return requestJson<{ changes: Array<{ field: string; from: string; to: string }> }>(`/api/requirements/${requirementId}/engineering`, {
        method: "PUT", body: JSON.stringify({ expectedToken: state.token, reason: draft.reason.trim(), fields }),
      });
    },
    onSuccess: async (result) => {
      toast.success(`Saved corrections for ${partNumber}`, {
        description: result.changes.map((change) => `${change.field}: ${change.from} → ${change.to}`).join(" · ") || "Adjustments updated",
      });
      setOpen(false);
      await refresh();
    },
    onError: handleConflict,
  });

  async function replaceFile(kind: OverrideFileKind, file: File) {
    if (!state) return;
    setError("");
    if (file.size > MAX_OVERRIDE_FILE_BYTES) { setError(`Files must be smaller than ${MAX_OVERRIDE_FILE_BYTES / 1024 / 1024} MB`); return; }
    setUploading(kind);
    try {
      const staged = await requestJson<{ path: string; token: string; contentType: string }>(
        `/api/requirements/${requirementId}/engineering/files/${kind}`, { method: "POST", body: JSON.stringify({ name: file.name, byteSize: file.size }) });
      const supabase = createClient();
      if (!supabase) throw new Error("Supabase is not configured in this browser");
      const { error: uploadError } = await supabase.storage.from("manufacturing-files").uploadToSignedUrl(staged.path, staged.token, file, { contentType: staged.contentType });
      if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
      await requestJson(`/api/requirements/${requirementId}/engineering/files/${kind}`, {
        method: "PUT", body: JSON.stringify({ stagingPath: staged.path, name: file.name, expectedToken: state.token, reason: draft?.reason.trim() ?? "" }),
      });
      toast.success(`${kind === "step" ? "STEP file" : "Drawing PDF"} replaced for ${partNumber}`);
      await refresh();
    } catch (caught) { handleConflict(caught); }
    finally { setUploading(null); }
  }

  async function revertFile(kind: OverrideFileKind) {
    if (!state) return;
    setError("");
    setUploading(kind);
    try {
      await requestJson(`/api/requirements/${requirementId}/engineering/files/${kind}`, {
        method: "DELETE", body: JSON.stringify({ expectedToken: state.token, reason: draft?.reason.trim() ?? "" }),
      });
      toast.success(`Restored the Onshape ${kind === "step" ? "STEP file" : "drawing PDF"} for ${partNumber}`);
      await refresh();
    } catch (caught) { handleConflict(caught); }
    finally { setUploading(null); }
  }

  const adjustments = state ? [
    ...(state.requirement?.off_the_shelf ? [{ key: "off_the_shelf", label: "Off-the-shelf", value: "Bought, not manufactured",
      synced: "Manufactured", by: state.requirement.off_the_shelf_changed_by ?? "Admin" }] : []),
    ...state.overrides.map((row) => ({ key: row.field, label: CORRECTION_FIELD_LABELS[row.field], value: display(row.value), synced: display(row.synced_value), by: row.updated_by_name })),
    ...state.file_overrides.map((row) => ({ key: row.kind, label: CORRECTION_FIELD_LABELS[row.kind], value: row.name,
      synced: state.files.find((file) => file.kind === row.kind)?.name ?? "none", by: row.updated_by_name })),
  ] : [];
  const requirementEditable = !obsolete && activeInBom;
  const busy = save.isPending || uploading !== null;
  const routingProblem = draft ? routingError(draft.routing) : null;
  const quantityProblem = draft && !/^\d+$/.test(draft.quantity.trim()) ? "Enter a whole number" : null;
  const nameProblem = draft && !draft.name.trim() ? "Enter a part name" : null;
  const dirty = Boolean(state && draft && Object.keys(changedFields(state, draft)).length);
  const sourcingChanged = Boolean(state && draft && draft.offTheShelf !== state.requirement?.off_the_shelf);
  // Routing and finishing only apply to manufactured parts, and change separately from sourcing.
  const routingEditable = requirementEditable && Boolean(draft && state) && !state!.requirement!.off_the_shelf && !sourcingChanged;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-[.14em] text-muted-foreground">Onshape data corrections</h3>
          {!compact && <p className="mt-1 text-xs text-muted-foreground">Adjustments persist across syncs until reverted or until Onshape matches them.</p>}
        </div>
        <Button size="sm" variant="outline" disabled={!state?.requirement} onClick={() => { if (state) setDraft(draftFrom(state)); setError(""); setOpen(true); }}>
          <PencilLine /> Correct Onshape data
        </Button>
      </div>
      {query.isError ? <p className="text-sm text-destructive">{query.error.message}</p>
        : adjustments.length > 0 ? (
          <ul className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-400/30 dark:bg-amber-400/10">
            {adjustments.map((item) => (
              <li key={item.key} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{item.label}</span>
                <span className="min-w-0 break-words">{item.value}</span>
                <span className="text-xs text-muted-foreground">Onshape: {item.synced} · {item.by}</span>
              </li>
            ))}
          </ul>
        ) : state && <p className="text-sm text-muted-foreground">No adjustments. This requirement shows the latest Onshape sync.</p>}

      <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
        <DialogContent forceBackdrop className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Correct Onshape data · {partNumber}</DialogTitle>
            <DialogDescription>Changes apply immediately, notify the shop in Slack, and survive future Onshape syncs. Each field adjustment retires automatically once Onshape delivers the same value.</DialogDescription>
          </DialogHeader>
          {!state || !draft ? <p role="status" className="text-sm text-muted-foreground">Loading engineering data…</p> : (
            <div className="space-y-5">
              {!requirementEditable && <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                {obsolete ? "This requirement is obsolete." : "This requirement is no longer active in the BOM."} Quantity, finishing, routing, and sourcing can’t be changed. Part details and files can.
              </p>}

              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold">Part details</legend>
                <p className="-mt-2 text-xs text-muted-foreground">Apply to every requirement for part {state.part?.part_number ?? partNumber}.</p>
                <label className="block text-sm">
                  <span className="font-semibold">Name</span>
                  <Input className="mt-1.5" value={draft.name} maxLength={MAX_NAME_LENGTH} disabled={busy} aria-invalid={Boolean(nameProblem)}
                    onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
                  <OverrideMeta override={overrideFor(state, "name")} disabled={busy}
                    onRevert={() => setDraft({ ...draft, name: String(overrideFor(state, "name")!.synced_value ?? "") })} />
                </label>
                <label className="block text-sm">
                  <span className="font-semibold">Description</span>
                  <textarea value={draft.description} maxLength={MAX_DESCRIPTION_LENGTH} disabled={busy} placeholder="No description"
                    onChange={(event) => setDraft({ ...draft, description: event.currentTarget.value })} className={`${TEXTAREA_CLASS} min-h-16`} />
                  <OverrideMeta override={overrideFor(state, "description")} disabled={busy}
                    onRevert={() => setDraft({ ...draft, description: String(overrideFor(state, "description")!.synced_value ?? "") })} />
                </label>
                <label className="block text-sm">
                  <span className="font-semibold">Material</span>
                  <Input className="mt-1.5" value={draft.material} maxLength={MAX_MATERIAL_LENGTH} disabled={busy}
                    onChange={(event) => setDraft({ ...draft, material: event.currentTarget.value })} placeholder="Not specified" />
                  <OverrideMeta override={overrideFor(state, "material")} disabled={busy}
                    onRevert={() => setDraft({ ...draft, material: String(overrideFor(state, "material")!.synced_value ?? "") })} />
                </label>
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="text-sm font-semibold">This requirement</legend>
                <label className="flex items-start gap-3 rounded-xl border p-3 text-sm">
                  <Checkbox className="mt-0.5" checked={draft.offTheShelf} disabled={busy || !requirementEditable}
                    onCheckedChange={(checked) => {
                      const initial = draftFrom(state);
                      setDraft({ ...draft, offTheShelf: Boolean(checked), routing: initial.routing, finishing: initial.finishing });
                    }} />
                  <span>
                    <span className="flex items-center gap-1.5 font-semibold"><ShoppingCart className="size-4" />Off-the-shelf part (buy, don’t manufacture)</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">Retires its operations, CAM, and finishing so nobody makes it. It stays in Production with an Off the Shelf status. Unchecking restores the routing below.</span>
                    {state.requirement?.off_the_shelf && state.requirement.off_the_shelf_changed_at && <span className="mt-1 block text-xs text-muted-foreground">
                      Marked by {state.requirement.off_the_shelf_changed_by ?? "an admin"} · {formatDate(state.requirement.off_the_shelf_changed_at)}</span>}
                  </span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="font-semibold">Quantity</span>
                    <Input className="mt-1.5" inputMode="numeric" value={draft.quantity} disabled={busy || !requirementEditable}
                      onChange={(event) => setDraft({ ...draft, quantity: event.currentTarget.value })} aria-invalid={Boolean(quantityProblem)} />
                    <OverrideMeta override={overrideFor(state, "required_quantity")} disabled={busy || !requirementEditable}
                      onRevert={() => setDraft({ ...draft, quantity: String(overrideFor(state, "required_quantity")!.synced_value) })} />
                  </label>
                  <label className="block text-sm">
                    <span className="font-semibold">Finishing color</span>
                    <Select value={draft.finishing} onValueChange={(value) => setDraft({ ...draft, finishing: normalizeFinishColor(value) })} disabled={busy || !routingEditable}>
                      <SelectTrigger className="mt-1.5 h-9 w-full bg-background"><SelectValue>{draft.finishing}</SelectValue></SelectTrigger>
                      <SelectContent align="start">{FINISH_COLORS.map((color) => <SelectItem key={color} value={color}>{color}</SelectItem>)}</SelectContent>
                    </Select>
                    <OverrideMeta override={overrideFor(state, "finishing")} disabled={busy || !routingEditable}
                      onRevert={() => setDraft({ ...draft, finishing: normalizeFinishColor(overrideFor(state, "finishing")!.synced_value) })} />
                  </label>
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-sm font-semibold">Operations</legend>
                <p className="mt-0.5 text-xs text-muted-foreground">{sourcingChanged
                  ? "Save the off-the-shelf change first; routing and finishing are edited separately."
                  : state.requirement?.off_the_shelf ? "Off-the-shelf parts have no active routing. Uncheck off-the-shelf to edit it."
                    : "CNC stages get a CAM task automatically. Stages with claimed or completed work can’t be changed."}</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {ROUTING_FIELDS.map((field, index) => (
                    <div key={field} className="text-sm">
                      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">OP{index + 1}</span>
                      <div className="mt-1"><MachineSelect label={`OP${index + 1} machine`} value={draft.routing[index]} disabled={busy || !routingEditable}
                        onChange={(value) => setDraft({ ...draft, routing: draft.routing.map((current, position) => position === index ? value : current) as Routing })} /></div>
                      <OverrideMeta override={overrideFor(state, field)} disabled={busy || !routingEditable}
                        onRevert={() => setDraft({ ...draft, routing: draft.routing.map((current, position) => position === index
                          ? (overrideFor(state, field)!.synced_value as string | null) ?? null : current) as Routing })} />
                    </div>
                  ))}
                </div>
                {routingProblem && <p className="mt-2 text-xs text-destructive">{routingProblem}</p>}
              </fieldset>

              <section>
                <h4 className="text-sm font-semibold">Files</h4>
                <p className="mt-0.5 text-xs text-muted-foreground">Replacements upload immediately and apply to every requirement for this part.</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {FILE_KINDS.map(({ kind, label, accept, icon: Icon }) => {
                    const replacement = state.file_overrides.find((file) => file.kind === kind);
                    const synced = state.files.find((file) => file.kind === kind);
                    return (
                      <div key={kind} className="rounded-xl border p-3 text-sm">
                        <div className="flex items-center gap-2 font-semibold"><Icon className="size-4 text-primary" />{label}{replacement && <Badge variant="outline">Replaced</Badge>}</div>
                        <p className="mt-1 truncate text-xs">{replacement?.name ?? synced?.name ?? "Missing"}</p>
                        {replacement && <p className="mt-0.5 truncate text-xs text-muted-foreground">Onshape: {synced?.name ?? "none"} · {replacement.updated_by_name}</p>}
                        {replacement && kind === "step" && <p className="mt-0.5 text-xs text-muted-foreground">
                          {replacement.preview ? "3D preview ready." : "3D preview pending. It appears after npm run manufacturing:generate-previews -- --apply --overrides-only."}</p>}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <input ref={(element) => { fileInputs.current[kind] = element; }} type="file" accept={accept} className="hidden"
                            onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void replaceFile(kind, file); }} />
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInputs.current[kind]?.click()}>
                            {uploading === kind ? <LoaderCircle className="animate-spin" /> : <Upload />}{replacement ? "Upload another" : "Replace"}
                          </Button>
                          {replacement && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revertFile(kind)}><RotateCcw />Use Onshape file</Button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <label className="block text-sm">
                <span className="font-semibold">Reason</span><span className="ml-2 text-xs text-muted-foreground">Optional; recorded in the audit history and posted to Slack</span>
                <textarea value={draft.reason} maxLength={MAX_OVERRIDE_REASON_LENGTH} disabled={busy}
                  onChange={(event) => setDraft({ ...draft, reason: event.currentTarget.value })}
                  placeholder="e.g. BOM counts the left and right bracket twice" className={`${TEXTAREA_CLASS} min-h-20`} />
              </label>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
            <Button disabled={busy || !dirty || Boolean(routingProblem) || Boolean(quantityProblem) || Boolean(nameProblem)} onClick={() => { setError(""); save.mutate(); }}>
              {save.isPending && <LoaderCircle className="animate-spin" />}Save corrections
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
