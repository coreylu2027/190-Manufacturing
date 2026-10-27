const shortDateTime = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** "Oct 18, 3:05 PM", or `fallback` when the time was never recorded. */
export function formatShortDateTime(value: string | null, fallback = "Not recorded") {
  return value ? shortDateTime.format(new Date(value)) : fallback;
}
