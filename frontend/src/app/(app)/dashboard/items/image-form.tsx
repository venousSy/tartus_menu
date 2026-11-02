"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import type { FormError } from "@/lib/api-errors";
import type { MenuItem } from "@/lib/server/owner-api";
import { CancelButton } from "../dialog-button";
import { BilingualName, FieldMessages, FormAlert, PRIMARY_BUTTON } from "../form-parts";
import { type ImageFormState, uploadItemImage } from "./actions";

/** UC-OWNER-006 A3: Django refuses a file over 2 MB. The browser checks the same limit first. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TOO_LARGE: FormError = { form: { key: "imageTooLarge" }, fields: {} };
const IDLE: ImageFormState = { error: null };

/**
 * Uploads a new image for the item (UC-OWNER-006). The page offers it only while the plan allows
 * images; Django checks that again, and the file too. After the upload the dialog closes and the
 * page shows the new image.
 *
 * A file over the limit is stopped here, before it is sent: Next refuses a Server Action body over
 * 3 MB (next.config.ts) before the action runs, and that shows the error screen, not a message.
 */
export function ImageForm({ item }: { item: MenuItem }) {
  const t = useTranslations("Items");
  const form = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(uploadItemImage, IDLE);
  const [tooLarge, setTooLarge] = useState(false);
  const hintId = useId();
  const errorId = useId();
  useEffect(() => {
    if (state.saved) form.current?.closest("dialog")?.close();
  }, [state]);
  const fieldMessages = state.error?.fields.image; // only when no file arrived at Django
  return (
    <form ref={form} action={formAction} className="flex flex-col gap-3"
      onSubmit={(event) => {
        if (tooLarge) event.preventDefault(); // React then does not call the action
      }}>
      <input type="hidden" name="id" value={item.id} />
      <BilingualName name={item.name} />
      {item.image_url && (
        <Image src={item.image_url} alt={t("currentImage")} width={160} height={160} unoptimized
          className="size-40 rounded-lg bg-stone-100 object-cover" />
      )}
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold">{t("newImage")}</span>
          {/* `accept` only filters the file picker: Django checks the content. */}
          <input type="file" name="image" required accept="image/jpeg,image/png,image/webp"
            onChange={(event) => setTooLarge((event.currentTarget.files?.[0]?.size ?? 0) > MAX_IMAGE_BYTES)}
            aria-invalid={fieldMessages ? true : undefined}
            aria-describedby={fieldMessages ? `${hintId} ${errorId}` : hintId}
            className="text-sm file:me-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-stone-200 file:px-3 file:font-semibold" />
        </label>
        <p id={hintId} className="text-sm text-stone-600">{t("imageHint")}</p>
        <FieldMessages id={errorId} messages={fieldMessages} />
      </div>
      <FormAlert error={tooLarge ? TOO_LARGE : state.error} />
      <div className="flex justify-end gap-2">
        <CancelButton />
        <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
          {pending ? t("uploading") : t("upload")}
        </button>
      </div>
    </form>
  );
}
