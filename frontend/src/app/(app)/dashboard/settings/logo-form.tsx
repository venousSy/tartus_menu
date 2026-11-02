"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import type { UploadState } from "@/lib/server/owner-actions";
import { FormAlert, PRIMARY_BUTTON } from "../form-parts";
import { ImageField, useImageSizeCheck } from "../image-field";
import { uploadLogo } from "./actions";

const IDLE: UploadState = { error: null };

/**
 * Uploads a new logo (UC-OWNER-010). The page offers it only while the plan allows branding; Django
 * checks that again, and the file too. After the upload the page shows the new logo.
 */
export function LogoForm() {
  const t = useTranslations("Settings");
  const [state, formAction, pending] = useActionState(uploadLogo, IDLE);
  const sizeCheck = useImageSizeCheck(state.error);
  return (
    <form action={formAction} onSubmit={sizeCheck.onSubmit} className="flex flex-col gap-3">
      <ImageField label={t("newLogo")} hint={t("logoHint")} messages={state.error?.fields.image}
        onChange={sizeCheck.onFileChange} />
      <FormAlert error={sizeCheck.error} />
      <p role="status" className="text-sm font-semibold text-green-800">{state.saved ? t("logoSaved") : ""}</p>
      <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} self-start`}>
        {pending ? t("uploading") : t("uploadLogo")}
      </button>
    </form>
  );
}
