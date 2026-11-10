import { EXPIRY_WARNING_DAYS } from "@/lib/i18n";

/**
 * A small warning next to a cafe whose subscription ends within 7 days (GC 5): `soon` ("3 days
 * left"), or `overdue` in red when the last paid day has passed and the nightly job has not
 * deactivated the cafe yet. Nothing for an inactive cafe, one without an end date, or more days.
 * The page passes the texts, already in the reader's language.
 */
export function ExpiryBadge({ daysLeft, soon, overdue }: { daysLeft: number | null; soon: string; overdue: string }) {
  if (daysLeft == null || daysLeft > EXPIRY_WARNING_DAYS) return null;
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${daysLeft < 0 ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"}`}>
      {daysLeft < 0 ? overdue : soon}
    </span>
  );
}
