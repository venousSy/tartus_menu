import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import type { ApiMessage, FormError } from "@/lib/api-errors";
import { FieldMessages } from "../ui/form-parts";

// Shared by the image uploads of the dashboard: item images (UC-OWNER-006) and the logo (UC-OWNER-010).
// No "use client" here: the client forms that import these run them in the browser.

/** UC-OWNER-006 A3, UC-OWNER-010 A2: Django refuses a file over 2 MB. The browser checks the same limit. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TOO_LARGE: FormError = { form: { key: "imageTooLarge" }, fields: {} };

/**
 * The browser's size check of an image form. A file over the limit is stopped before it is sent:
 * Next refuses a Server Action body over 3 MB (next.config.ts) before the action runs, and that
 * shows the error screen, not a message. Gives the file input's onChange, the form's onSubmit and
 * the error the form shows: the size message, or the action's own error.
 */
export function useImageSizeCheck(actionError: FormError | null) {
  const [tooLarge, setTooLarge] = useState(false);
  return {
    error: tooLarge ? TOO_LARGE : actionError,
    onFileChange: (event: ChangeEvent<HTMLInputElement>) =>
      setTooLarge((event.currentTarget.files?.[0]?.size ?? 0) > MAX_IMAGE_BYTES),
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      if (tooLarge) event.preventDefault(); // React then does not call the action
    },
  };
}

/** The file input of an image upload, sent as "image", with its hint and Django's messages for it. */
export function ImageField({ label, hint, messages, onChange }: {
  label: string;
  hint: string;
  messages?: ApiMessage[]; // only when no file arrived at Django
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{label}</span>
        {/* `accept` only filters the file picker: Django checks the content. */}
        <input type="file" name="image" required accept="image/jpeg,image/png,image/webp" onChange={onChange}
          aria-invalid={messages ? true : undefined}
          aria-describedby={messages ? `${hintId} ${errorId}` : hintId}
          className="text-sm file:me-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-stone-200 file:px-3 file:font-semibold" />
      </label>
      <p id={hintId} className="text-sm text-stone-600">{hint}</p>
      <FieldMessages id={errorId} messages={messages} />
    </div>
  );
}
