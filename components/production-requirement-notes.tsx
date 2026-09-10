"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

const MANUFACTURING_QUERY_KEYS = ["operations", "fabrication", "qc", "admin"] as const;

async function saveProductionNotes(requirementId: number, notes: string): Promise<{ productionNotes: string }> {
  const response = await fetch(`/api/requirements/${requirementId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Unable to update production notes");
  return body;
}

export function ProductionRequirementNotes({
  requirementId,
  notes,
  compact = false,
}: {
  requirementId: number;
  notes: string;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(notes);

  const mutation = useMutation({
    mutationFn: () => saveProductionNotes(requirementId, draft),
    onSuccess: (result) => {
      setDraft(result.productionNotes);
      for (const queryKey of MANUFACTURING_QUERY_KEYS) {
        queryClient.invalidateQueries({ queryKey: [queryKey] }, { cancelRefetch: false });
      }
      toast.success(result.productionNotes ? "Production note saved" : "Production note deleted");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update production notes"),
  });

  const changed = draft.trim() !== notes;
  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <label className="block text-xs font-bold uppercase tracking-[.14em] text-muted-foreground" htmlFor={`production-notes-${requirementId}`}>Production note</label>
          {!compact && <p className="mt-1 text-xs text-muted-foreground">Shared across every operation for this production requirement.</p>}
        </div>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending || !changed}>
          {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />} Save
        </Button>
      </div>
      <textarea
        id={`production-notes-${requirementId}`}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        maxLength={5000}
        disabled={mutation.isPending}
        placeholder="Add measurements, handoff details, issues, or other notes for this part…"
        className={`${compact ? "min-h-24" : "min-h-32"} w-full resize-y rounded-xl border border-input bg-background px-4 py-3 text-sm leading-6 text-foreground caret-foreground outline-none disabled:opacity-70 focus:border-ring focus:ring-3 focus:ring-ring/50`}
      />
    </section>
  );
}
