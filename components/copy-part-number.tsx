"use client";

import { toast } from "sonner";

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

export function PartNumberCell({ value }: { value?: string }) {
  return value ? <CopyPartNumber partNumber={value} /> : null;
}
