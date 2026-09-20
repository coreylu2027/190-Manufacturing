"use client";

import { toast } from "sonner";
import { HiddenBadge, ObsoleteBadge } from "@/components/requirement-obsoletion";

export function CopyPartNumber({ partNumber }: { partNumber: string }) {
  return (
    <button
      type="button"
      className="cursor-copy rounded-sm text-left font-mono font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-primary"
      title={`Copy ${partNumber}`}
      aria-label={`Copy part number ${partNumber}`}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(partNumber);
          toast.success(`Copied ${partNumber}`);
        } catch {
          toast.error("Unable to copy the part number");
        }
      }}
    >
      {partNumber}
    </button>
  );
}

export function PartNumberCell({ value, data }: { value?: string; data?: { obsolete?: boolean; hidden?: boolean; operations?: { obsolete?: boolean }[] } }) {
  return value ? <div className="flex h-full flex-col justify-center gap-0.5 leading-4"><CopyPartNumber partNumber={value} /><span className="flex gap-1"><ObsoleteBadge obsolete={data?.obsolete ?? data?.operations?.[0]?.obsolete} /><HiddenBadge hidden={data?.hidden} /></span></div> : null;
}
