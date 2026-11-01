// Turns Django's error answers into messages the dashboards can show in Arabic or English. Django
// answers in English (use_cases.md, DRF's standard field messages); known texts get a key of the
// "ApiErrors" messages, others are shown as they are. Plain functions: Server Actions build these
// values on the server, and client forms render them.

/** The keys of the "ApiErrors" namespace in src/messages/*.json. */
export type ApiErrorKey =
  | "serverError" | "notFound" | "subscriptionInactive" | "planLimitCategories" | "planLimitItems"
  | "imagesNeedPro" | "colorsNeedPro" | "logosNeedPro" | "imageType" | "imageTooLarge"
  | "imageDimensions" | "imageUploadFailed" | "qrFirst" | "required" | "maxLength" | "invalidNumber"
  | "invalidInteger" | "minValue" | "maxValue" | "maxDigits" | "maxDecimals" | "maxWholeDigits" | "colorFormat"
  | "listChanged";

/** A message to show: a known one by key, translated when the page renders, or Django's own text. */
export type ApiMessage = { key: ApiErrorKey; values?: Record<string, string | number> } | { text: string };

/** A failed write, for its form: one message for the whole form, and messages per field ("name.ar"). */
export type FormError = { form: ApiMessage | null; fields: Record<string, ApiMessage[]> };

/** For a write that never got an answer from Django (no network, or a server error page). */
export const SERVER_ERROR: FormError = { form: { key: "serverError" }, fields: {} };

// Django's texts as patterns. The listed names receive the numbers or words the text contains.
const KNOWN: [RegExp, ApiErrorKey, string[]?][] = [
  [/^Your subscription is inactive\. Please contact support\.$/, "subscriptionInactive"],
  [/^Your (.+) plan allows a maximum of (\d+) categories\./, "planLimitCategories", ["plan", "max"]],
  [/^Your (.+) plan allows a maximum of (\d+) items\./, "planLimitItems", ["plan", "max"]],
  [/^Item images require a Pro plan\.$/, "imagesNeedPro"],
  [/^Custom colors require a Pro plan\.$/, "colorsNeedPro"],
  [/^Custom logos require a Pro plan\.$/, "logosNeedPro"],
  [/^Only JPEG, PNG, and WebP images are allowed\.$/, "imageType"],
  [/^Image must be under 2MB\.$/, "imageTooLarge"],
  [/^Image dimensions are too large\.$/, "imageDimensions"],
  [/^Image upload failed\. Please try again\.$/, "imageUploadFailed"],
  [/^Please generate QR codes first\.$/, "qrFirst"],
  [/^The list must include every (?:category|item of the category) exactly once\.$/, "listChanged"],
  [/^Reorder must be within one category\.$/, "listChanged"],
  [/^Not found\.$/, "notFound"],
  [/^This field (?:is required|may not be blank)\.$/, "required"],
  [/^Ensure this field has no more than (\d+) characters\.$/, "maxLength", ["max"]],
  [/^A valid number is required\.$/, "invalidNumber"],
  [/^A valid integer is required\.$/, "invalidInteger"],
  [/^Ensure this value is greater than or equal to (\d+)\.$/, "minValue", ["min"]],
  [/^Ensure this value is less than or equal to (\d+)\.$/, "maxValue", ["max"]],
  [/^Ensure that there are no more than (\d+) digits in total\.$/, "maxDigits", ["max"]],
  [/^Ensure that there are no more than (\d+) decimal places\.$/, "maxDecimals", ["max"]],
  [/^Ensure that there are no more than (\d+) digits before the decimal point\.$/, "maxWholeDigits", ["max"]],
  [/^Enter a color in #RRGGBB format\.$/, "colorFormat"],
];

/** One of Django's texts as a message. Numbers stay numbers, so plural rules can use them. */
export function toApiMessage(text: string): ApiMessage {
  for (const [pattern, key, names = []] of KNOWN) {
    const match = pattern.exec(text);
    if (match) {
      if (names.length === 0) return { key };
      const values = Object.fromEntries(
        names.map((name, i) => [name, /^\d+$/.test(match[i + 1]) ? Number(match[i + 1]) : match[i + 1]]),
      );
      return { key, values };
    }
  }
  return { text };
}

/**
 * Django's error body as a FormError. DRF answers {"detail": "..."} for the whole request, or field
 * errors such as {"name": {"ar": ["..."]}, "price": ["..."]}; nested fields become paths like "name.ar".
 * A body without any message (for example an HTML error page) becomes SERVER_ERROR.
 */
export function toFormError(body: unknown): FormError {
  const error: FormError = { form: null, fields: {} };
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (path === "" || path === "detail" || path === "non_field_errors") {
        error.form ??= toApiMessage(value);
      } else {
        (error.fields[path] ??= []).push(toApiMessage(value));
      }
    } else if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path));
    } else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) visit(inner, path ? `${path}.${key}` : key);
    }
  };
  visit(body, "");
  return error.form || Object.keys(error.fields).length > 0 ? error : SERVER_ERROR;
}
