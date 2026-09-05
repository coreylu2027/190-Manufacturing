"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, MapPin } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROBOT_LOCATION, STORAGE_LOCATION_GROUPS, type StorageLocation } from "@/lib/storage-locations";

const NO_LOCATION = "__not_recorded__";

export function StorageLocationSelect({
  value,
  onChange,
  disabled = false,
  allowOnRobot = false,
  className,
}: {
  value: StorageLocation | null;
  onChange: (value: StorageLocation | null) => void;
  disabled?: boolean;
  allowOnRobot?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value ?? NO_LOCATION}
      onValueChange={(next) => onChange(next === NO_LOCATION || next === null ? null : next as StorageLocation)}
      disabled={disabled}
    >
      <SelectTrigger className={className ?? "h-9 w-full bg-background"}>
        <MapPin className="text-muted-foreground" />
        <SelectValue>{value ?? "Not recorded"}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={NO_LOCATION}>Not recorded</SelectItem>
        {allowOnRobot && <SelectItem value={ROBOT_LOCATION}>{ROBOT_LOCATION}</SelectItem>}
        <SelectSeparator />
        {STORAGE_LOCATION_GROUPS.map((group) => (
          <SelectGroup key={group.name}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.locations.map((location) => (
              <SelectItem key={location} value={location}>{location}</SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatLocationDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function StorageLocationEditor({
  requirementId,
  value,
  updatedBy,
  updatedAt,
  canEdit,
  allowOnRobot = false,
}: {
  requirementId: number;
  value: StorageLocation | null;
  updatedBy: string | null;
  updatedAt: string | null;
  canEdit: boolean;
  allowOnRobot?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draftOverride, setDraftOverride] = useState<StorageLocation | null | undefined>(undefined);
  const draft = draftOverride === undefined ? value : draftOverride;

  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/requirements/${requirementId}/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: draft }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to update the storage location");
      return body;
    },
    onSuccess: () => {
      toast.success(draft ? `Location updated to ${draft}` : "Storage location cleared");
      for (const queryKey of [["admin"], ["qc"], ["operations"], ["fabrication"]]) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update the storage location"),
  });

  return (
    <div className="space-y-2 rounded-xl border bg-muted/20 p-4">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Part location</p>
        <p className="mt-1 text-sm font-semibold">{value ?? "Not recorded"}</p>
        {updatedAt && (
          <p className="mt-1 text-xs text-muted-foreground">
            Updated {formatLocationDate(updatedAt)}{updatedBy ? ` by ${updatedBy}` : ""}
          </p>
        )}
      </div>
      {canEdit && (
        <div className="flex items-center gap-2">
          <StorageLocationSelect value={draft} onChange={setDraftOverride} disabled={mutation.isPending} allowOnRobot={allowOnRobot} />
          <Button
            size="sm"
            variant="outline"
            disabled={mutation.isPending || draft === value}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <LoaderCircle className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
