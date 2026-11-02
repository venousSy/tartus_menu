"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import type { UploadState } from "@/lib/server/owner-actions";
import type { MenuItem } from "@/lib/server/owner-api";
import { CancelButton } from "../../ui/dialog-button";
import { BilingualName, FormAlert, PRIMARY_BUTTON } from "../../ui/form-parts";
import { ImageField, useImageSizeCheck } from "../image-field";
import { uploadItemImage } from "./actions";

const IDLE: UploadState = { error: null };

/**
 * Uploads a new image for the item (UC-OWNER-006). The page offers it only while the plan allows
 * images; Django checks that again, and the file too. After the upload the dialog closes and the
 * page shows the new image.
 */
export function ImageForm({ item }: { item: MenuItem }) {
  const t = useTranslations("Items");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(uploadItemImage, IDLE);
  const sizeCheck = useImageSizeCheck(state.error);
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  return (
    <form ref={form} action={formAction} onSubmit={sizeCheck.onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={item.id} />
      <BilingualName name={item.name} />
      {item.image_url && (
        <Image src={item.image_url} alt={t("currentImage")} width={160} height={160} unoptimized
          className="size-40 rounded-lg bg-stone-100 object-cover" />
      )}
      <ImageField label={t("newImage")} hint={t("imageHint")} messages={state.error?.fields.image}
        onChange={sizeCheck.onFileChange} />
      <FormAlert error={sizeCheck.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? t("uploading") : t("upload")}
        </button>
      </div>
    </form>
  );
}
