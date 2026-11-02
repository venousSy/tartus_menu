"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { FormAlert, PRIMARY_BUTTON, TextField } from "../form-parts";
import { generateQrCodes, type QrFormState } from "./actions";

const IDLE: QrFormState = { error: null };

/**
 * The number of tables, and the button that creates their QR codes (UC-OWNER-007). The input starts
 * with the current count, so generating again without a change keeps everything as it is (A3).
 */
export function GenerateForm({ tableCount }: { tableCount: number }) {
  const t = useTranslations("Qr");
  const [state, formAction, pending] = useActionState(generateQrCodes, IDLE);
  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4">
      <TextField label={t("tableCount")} name="table_count" inputMode="numeric" required
        defaultValue={state.tableCount ?? (tableCount > 0 ? String(tableCount) : "")}
        messages={state.error?.fields.table_count} />
      <p className="text-sm text-stone-600">{t("tableCountHint")}</p>
      <FormAlert error={state.error} />
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("generating") : t("generate")}
      </button>
    </form>
  );
}
