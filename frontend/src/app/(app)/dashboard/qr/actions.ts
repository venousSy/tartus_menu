"use server";

import { type ActionState, writeThenRefresh } from "@/lib/server/owner-actions";

// The Server Action of the QR codes screen (UC-OWNER-007). Django checks the count and keeps the
// tables; this action only carries the count to it.

/** The generate form's state: `tableCount` refills the input after a refused count. */
export type QrFormState = ActionState & { tableCount?: string };

/**
 * Makes tables 1 to N the active ones. Django checks N (1 to 200: A1, A2), keeps the code of every
 * table that already exists (A3), and deactivates the tables above N without deleting them (A4).
 */
export async function generateQrCodes(_previous: QrFormState, formData: FormData): Promise<QrFormState> {
  const tableCount = String(formData.get("table_count") ?? "");
  // Sent as typed: Django reads "12" as 12 and refuses anything that is not a whole number.
  const error = await writeThenRefresh("/dashboard/qr/generate/", { method: "POST", json: { table_count: tableCount } });
  return error ? { error, tableCount } : { error: null };
}
