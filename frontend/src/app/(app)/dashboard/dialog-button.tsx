"use client";

import { useTranslations } from "next-intl";
import { Fragment, type ReactNode, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SECONDARY_BUTTON } from "./form-parts";

/**
 * A button and the modal dialog it opens. The dialog and its form are part of the page from the
 * start, so the form exists for a post without JavaScript too. Each opening renders the form anew
 * (`key`): the current values, without the error or the typing of the last time. A form taller
 * than the screen scrolls inside the dialog.
 */
export function DialogButton({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [openings, setOpenings] = useState(0);
  const titleId = useId();
  return (
    <>
      <button type="button" className={SECONDARY_BUTTON}
        onClick={() => {
          // The new form must be in place before showModal() moves the focus to its first field.
          flushSync(() => setOpenings((count) => count + 1));
          dialog.current?.showModal();
        }}>
        {label}
      </button>
      <dialog ref={dialog} aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100%-2rem))] overflow-y-auto rounded-lg p-4 backdrop:bg-black/40">
        <h3 id={titleId} className="mb-3 font-bold">{title}</h3>
        <Fragment key={openings}>{children}</Fragment>
      </dialog>
    </>
  );
}

/** Closes the dialog around the button; the Escape key does the same. */
export function CancelButton() {
  const t = useTranslations("Forms");
  return (
    <button type="button" className={SECONDARY_BUTTON} onClick={(event) => event.currentTarget.closest("dialog")?.close()}>
      {t("cancel")}
    </button>
  );
}
