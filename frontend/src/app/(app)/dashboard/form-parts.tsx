import { useTranslations } from "next-intl";
import { useId } from "react";
import type { ApiMessage, FormError } from "@/lib/api-errors";
import { type BilingualText, dirOf, type Lang, NAME_MAX_LENGTH } from "@/lib/i18n";

// Pieces shared by the dashboard's forms. They show Django's errors (src/lib/api-errors.ts) in the
// reader's language. No "use client" here: the client forms that import them run them in the browser.

export const PRIMARY_BUTTON =
  "min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-60";
export const SECONDARY_BUTTON =
  "min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-sm font-semibold disabled:opacity-60";
export const DANGER_BUTTON =
  "min-h-11 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-60";

/** One of Django's messages: a known text in the reader's language (ApiErrors), any other as Django wrote it. */
export function ApiMessageText({ message }: { message: ApiMessage }) {
  const t = useTranslations("ApiErrors");
  return "key" in message ? t(message.key, message.values) : message.text;
}

/** The message of a failed action for the whole form, for example a plan limit. Read out when it appears. */
export function FormAlert({ error }: { error: FormError | null }) {
  if (!error?.form) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
      <ApiMessageText message={error.form} />
    </p>
  );
}

type TextFieldProps = {
  label: string;
  name: string;
  lang: Lang; // the language of the text typed here, not of the page
  defaultValue: string;
  required?: boolean;
  maxLength?: number;
  messages?: ApiMessage[];
};

/** A labelled input for text in one language, with Django's messages for that field below it. */
export function TextField({ label, name, lang, defaultValue, required, maxLength, messages = [] }: TextFieldProps) {
  const errorId = useId();
  const invalid = messages.length > 0;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{label}</span>
        <input name={name} lang={lang} dir={dirOf(lang)} defaultValue={defaultValue} required={required}
          maxLength={maxLength} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined}
          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 aria-invalid:border-red-600" />
      </label>
      {invalid && (
        <p id={errorId} className="text-sm text-red-700">
          {messages.map((message, index) => (
            <span key={index} className="block"><ApiMessageText message={message} /></span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * The Arabic and English inputs of a name (GC 6), sent as "name_ar" and "name_en", with Django's
 * errors for "name.ar" and "name.en". The values are always strings: React resets a form to them.
 */
export function NameFields({ names, error }: { names?: BilingualText; error: FormError | null }) {
  const t = useTranslations("Forms");
  return (
    <>
      <TextField label={t("nameAr")} name="name_ar" lang="ar" required maxLength={NAME_MAX_LENGTH}
        defaultValue={names?.ar ?? ""} messages={error?.fields["name.ar"]} />
      <TextField label={t("nameEn")} name="name_en" lang="en" maxLength={NAME_MAX_LENGTH}
        defaultValue={names?.en ?? ""} messages={error?.fields["name.en"]} />
    </>
  );
}
