import { useTranslations } from "next-intl";
import { useId } from "react";
import type { ApiMessage, FormError } from "@/lib/api-errors";
import { type BilingualText, dirOf, type Lang, NAME_MAX_LENGTH } from "@/lib/i18n";

// Pieces shared by the dashboard's forms and rows. They show Django's errors (src/lib/api-errors.ts)
// in the reader's language. No "use client" here: the client forms that import them run them in the browser.

export const PRIMARY_BUTTON =
  "min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-on-primary disabled:opacity-60";
export const SECONDARY_BUTTON =
  "min-h-11 rounded-lg border border-stone-300 bg-white px-3 text-sm font-semibold disabled:opacity-60";
export const DANGER_BUTTON =
  "min-h-11 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-60";

/** Both names of a category or an item. <bdi> keeps each name's own direction in a page of either language. */
export function BilingualName({ name }: { name: BilingualText }) {
  return (
    <span className="flex flex-col">
      <span className="font-semibold"><bdi lang="ar">{name.ar}</bdi></span>
      {name.en && <span className="text-sm text-stone-600"><bdi lang="en">{name.en}</bdi></span>}
    </span>
  );
}

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

/** Django's messages for one field, below it. The field points here with aria-describedby. */
export function FieldMessages({ id, messages = [] }: { id: string; messages?: ApiMessage[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} className="text-sm text-red-700">
      {messages.map((message, index) => (
        <span key={index} className="block"><ApiMessageText message={message} /></span>
      ))}
    </p>
  );
}

type TextFieldProps = {
  label: string;
  name: string;
  lang?: Lang; // the language of the text typed here, not of the page; none for a number
  defaultValue: string;
  required?: boolean;
  maxLength?: number;
  inputMode?: "decimal"; // a keypad with a decimal point on phones
  multiline?: boolean; // a textarea, for longer texts such as a description
  messages?: ApiMessage[];
};

/** A labelled input for text in one language (or a number), with Django's messages for it below. */
export function TextField({ label, name, lang, defaultValue, required, maxLength, inputMode, multiline, messages = [] }: TextFieldProps) {
  const errorId = useId();
  const invalid = messages.length > 0;
  const shared = {
    name, lang, defaultValue, required, maxLength,
    dir: lang ? dirOf(lang) : "ltr", // numbers read left to right in both languages (GC 10)
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? errorId : undefined,
    className: "min-h-11 rounded-lg border border-stone-300 bg-white px-3 aria-invalid:border-red-600",
  } as const;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{label}</span>
        {multiline ? <textarea rows={3} {...shared} /> : <input inputMode={inputMode} {...shared} />}
      </label>
      <FieldMessages id={errorId} messages={messages} />
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
