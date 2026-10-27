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
import { formatShortDateTime } from "@/lib/date-format";
import { invalidateManufacturingQueries } from "@/lib/query-keys";
import { requestJson } from "@/lib/request-json";
import { ROBOT_LOCATION, STORAGE_LOCATION_GROUPS, type StorageLocation } from "@/lib/storage-locations";

const NO_LOCATION = "__not_recorded__";

export function StorageLocationSelect({
  value,
  onChange,
  disabled = false,
  allowOnRobot = false,
  showUnavailableOnRobot = false,
  emptyLabel = "Not recorded",
}: {
  value: StorageLocation | null;
  onChange: (value: StorageLocation | null) => void;
  disabled?: boolean;
  allowOnRobot?: boolean;
  showUnavailableOnRobot?: boolean;
  emptyLabel?: string;
}) {
  return (
    <Select
      value={value ?? NO_LOCATION}
      onValueChange={(next) => onChange(next === NO_LOCATION || next === null ? null : next as StorageLocation)}
      disabled={disabled}
    >
      <SelectTrigger className="h-9 w-full bg-background">
        <MapPin className="text-muted-foreground" />
        <SelectValue>{value ?? emptyLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value={NO_LOCATION}>{emptyLabel}</SelectItem>
        {(allowOnRobot || showUnavailableOnRobot) && <SelectItem value={ROBOT_LOCATION} disabled={!allowOnRobot}>{ROBOT_LOCATION}</SelectItem>}
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

export function StorageLocationEditor({
  requirementId,
  value,
  updatedBy,
  updatedAt,
  allowOnRobot = false,
}: {
  requirementId: number;
  value: StorageLocation | null;
  updatedBy: string | null;
  updatedAt: string | null;
  allowOnRobot?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draftOverride, setDraftOverride] = useState<StorageLocation | null | undefined>(undefined);
  const draft = draftOverride === undefined ? value : draftOverride;

  const mutation = useMutation({
    mutationFn: () => requestJson(`/api/requirements/${requirementId}/location`, {
      method: "PATCH", body: JSON.stringify({ location: draft }),
    }, "Unable to update the storage location"),
    onSuccess: () => {
      toast.success(draft ? `Location updated to ${draft}` : "Storage location cleared");
      void invalidateManufacturingQueries(queryClient);
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
            Updated {formatShortDateTime(updatedAt)}{updatedBy ? ` by ${updatedBy}` : ""}
          </p>
        )}
      </div>
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
    </div>
  );
}
