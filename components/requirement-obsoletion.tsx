"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Eye, EyeOff, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ObsoletionFields } from "@/lib/types";

export function ObsoleteBadge({ obsolete }: { obsolete?: boolean }) {
  return obsolete ? <span className="inline-flex rounded border border-red-300 bg-red-50 px-1.5 py-0.5 font-sans text-[10px] font-bold leading-4 text-red-800 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-200">Obsolete</span> : null;
}

export function HiddenBadge({ hidden }: { hidden?: boolean }) {
  return hidden ? <span className="inline-flex rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-bold leading-4 text-muted-foreground">Hidden</span> : null;
}

export function RequirementVisibility({ requirementId, state }: { requirementId: number; state: ObsoletionFields }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ hidden, expectedVersion }: { hidden: boolean; expectedVersion: number; suppressUndo?: boolean }) => {
      const response = await fetch(`/api/requirements/${requirementId}/visibility`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hidden, expectedVersion }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to change visibility");
      return body as { hidden: boolean; visibilityVersion: number };
    },
    onSuccess: (result, variables) => {
      toast.success(result.hidden ? "Requirement hidden from everyone's lists" : "Requirement shown in lists", variables.suppressUndo ? undefined : {
        action: { label: "Undo", onClick: () => mutation.mutate({ hidden: !result.hidden, expectedVersion: result.visibilityVersion, suppressUndo: true }) },
      });
    },
    onError: (error) => toast.error(error.message),
    onSettled: async () => {
      await Promise.all(["operations", "cam", "fabrication", "qc", "admin"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  if (!state.obsolete) return null;
  return <section className="space-y-2">
    <Button variant="outline" disabled={mutation.isPending}
      onClick={() => mutation.mutate({ hidden: !state.hidden, expectedVersion: state.visibilityVersion })}>
      {state.hidden ? <Eye /> : <EyeOff />}{state.hidden ? "Unhide requirement" : "Hide obsolete requirement"}
    </Button>
    <p className="text-xs text-muted-foreground">{state.hidden
      ? "Hidden from everyone's normal lists. Admins can find it using Show hidden."
      : "Hide this obsolete requirement from everyone's normal lists. Its history will be preserved."}</p>
  </section>;
}

export function ObsoleteWarning({ obsolete, onRobot = false }: { obsolete?: boolean; onRobot?: boolean }) {
  return obsolete ? <div role="status" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-100">
    <p className="font-bold">Obsolete — Do not manufacture or install</p>
    <p className="mt-1">Work is stopped for this production requirement. Its manufacturing history is preserved.</p>
    {onRobot && <p className="mt-1 font-semibold">This part is recorded as On Robot. Remove it and update its location.</p>}
  </div> : null;
}

export function RequirementObsoletion({ requirementId, state }: { requirementId: number; state: ObsoletionFields & { activeInBom: boolean } }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ obsolete, expectedVersion }: { obsolete: boolean; expectedVersion: number; suppressUndo?: boolean }) => {
      const response = await fetch(`/api/requirements/${requirementId}/obsoletion`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ obsolete, expectedVersion }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to change obsoletion");
      return body as { obsolete: boolean; obsoletionVersion: number };
    },
    onSuccess: (result, variables) => {
      toast.success(result.obsolete ? "Requirement marked obsolete" : "Requirement restored from obsolete", variables.suppressUndo ? undefined : {
        action: { label: "Undo", onClick: () => mutation.mutate({ obsolete: !result.obsolete, expectedVersion: result.obsoletionVersion, suppressUndo: true }) },
      });
    },
    onError: (error) => toast.error(error.message),
    onSettled: async () => {
      await Promise.all(["operations", "cam", "fabrication", "qc", "admin"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
  return <section className="space-y-2">
    {!state.activeInBom && <p className="text-sm text-muted-foreground">This historical requirement is no longer active in the BOM. Restoring it does not reactivate its routing.</p>}
    <Button variant={state.obsolete ? "outline" : "destructive"} disabled={mutation.isPending}
      onClick={() => mutation.mutate({ obsolete: !state.obsolete, expectedVersion: state.obsoletionVersion })}>
      {state.obsolete ? <RotateCcw /> : <Ban />}{state.obsolete ? "Restore from obsolete" : "Mark obsolete"}
    </Button>
    {state.obsoletionChangedAt && <p className="text-xs text-muted-foreground">
      {state.obsolete ? "Marked obsolete" : "Restored"} by {state.obsoletionChangedBy ?? "Engineering sync"}
      {" · "}{new Date(state.obsoletionChangedAt).toLocaleString()}
      {state.replacementRequirementId && ` · Replacement requirement #${state.replacementRequirementId}`}
    </p>}
  </section>;
}
