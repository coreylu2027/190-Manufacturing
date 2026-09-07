"use client";

import { useState } from "react";

export function ExpandableText({
  text,
  maxLength = 120,
  className,
}: {
  text: string;
  maxLength?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (text.length <= maxLength) return <span className={className}>{text}</span>;

  return (
    <span className={className}>
      <span className="[overflow-wrap:anywhere]">{expanded ? text : text.slice(0, maxLength).trimEnd()}</span>
      {expanded ? (
        <button
          type="button"
          className="ml-1 inline rounded-sm text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      ) : (
        <button
          type="button"
          aria-label="Show full value"
          title="Show full value"
          className="inline rounded-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded(true)}
        >
          …
        </button>
      )}
    </span>
  );
}
