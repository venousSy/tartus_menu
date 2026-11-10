// Turns Django's error answers into messages the dashboards can show in Arabic or English. Django
// answers in English (use_cases.md, DRF's standard field messages); a whole-request error also names
// its code in the X-Error-Code header. Known codes and texts get a key of the "ApiErrors" messages,
// others are shown as they are. Plain functions: Server Actions build these
// values on the server, and client forms render them.

/** The keys of the "ApiErrors" namespace in src/messages/*.json. */
export type ApiErrorKey =
  | "serverError" | "notFound" | "subscriptionInactive" | "planLimitCategories" | "planLimitItems"
  | "imagesNeedPro" | "colorsNeedPro" | "logosNeedPro" | "imageType" | "imageTooLarge"
  | "imageDimensions" | "imageUploadFailed" | "qrFirst" | "required" | "maxLength" | "invalidNumber"
  | "invalidInteger" | "minValue" | "maxValue" | "maxDigits" | "maxDecimals" | "maxWholeDigits" | "colorFormat"
  | "listChanged" | "wrongPassword" | "samePassword" | "passwordTooShort" | "passwordTooCommon"
  | "passwordNumeric" | "passwordTooSimilar" | "slugTaken" | "slugFormat" | "emailTaken" | "emailFormat"
  | "unknownPlan" | "alreadyActive" | "alreadyInactive" | "downgradeCategories" | "downgradeItems"
  | "resetLinkInvalid" | "dateFormat" | "datePast" | "dateTooFar" | "dateNotLater" | "renewInactive";

/** A message to show: a known one by key, translated when the page renders, or Django's own text. */
export type ApiMessage = { key: ApiErrorKey; values?: Record<string, string | number> } | { text: string };

/** A failed write, for its form: one message for the whole form, and messages per field ("name.ar"). */
export type FormError = { form: ApiMessage | null; fields: Record<string, ApiMessage[]> };

/** For a write that never got an answer from Django (no network, or a server error page). */
export const SERVER_ERROR: FormError = { form: { key: "serverError" }, fields: {} };

// Django's texts as patterns. The listed names receive the numbers or words the text contains.
const KNOWN: [RegExp, ApiErrorKey, string[]?][] = [
  [/^Your subscription is inactive\. Please contact support\.$/, "subscriptionInactive"],
  [/^Your (.+) plan allows a maximum of (\d+) categor(?:y|ies)\./, "planLimitCategories", ["plan", "max"]],
  [/^Your (.+) plan allows a maximum of (\d+) items?\./, "planLimitItems", ["plan", "max"]],
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
  // UC-AUTH-004: the change-password serializer and Django's AUTH_PASSWORD_VALIDATORS.
  [/^Incorrect password\.$/, "wrongPassword"],
  [/^The new password must be different from the old password\.$/, "samePassword"],
  [/^This password is too short\. It must contain at least (\d+) characters?\.$/, "passwordTooShort", ["min"]],
  [/^This password is too common\.$/, "passwordTooCommon"],
  [/^This password is entirely numeric\.$/, "passwordNumeric"],
  [/^The password is too similar to the .+\.$/, "passwordTooSimilar"], // the field name is English
  [/^This reset link is invalid or has expired\.$/, "resetLinkInvalid"], // UC-AUTH-005 A1
  // UC-ADMIN-001 to 006: the admin serializers (DRF's SlugField, EmailField, SlugRelatedField) and services.
  [/^A cafe with this slug already exists\.$/, "slugTaken"],
  [/^Enter a valid .slug. consisting of letters, numbers, underscores or hyphens\.$/, "slugFormat"], // “slug” in curly quotes
  [/^A user with this email already exists\.$/, "emailTaken"],
  [/^Enter a valid email address\.$/, "emailFormat"],
  [/^Object with name=.* does not exist\.$/, "unknownPlan"],
  [/^Cafe is already active\.$/, "alreadyActive"],
  [/^Cafe is already inactive\.$/, "alreadyInactive"],
  // UC-ADMIN-004 A5-A7 and UC-ADMIN-011: the last paid day of a subscription.
  [/^Date has wrong format\./, "dateFormat"],
  [/^The date must be today or later\.$/, "datePast"],
  [/^The date must be within 2 years from today\.$/, "dateTooFar"],
  [/^The date must be later than the current end date\.$/, "dateNotLater"],
  [/^Cafe is inactive\. Activate it instead\.$/, "renewInactive"],
  [/^Cannot downgrade to (.+): cafe has (\d+) categories \(max (\d+)\)\.$/, "downgradeCategories", ["plan", "count", "max"]],
  [/^Cannot downgrade to (.+): cafe has (\d+) items \(max (\d+)\)\.$/, "downgradeItems", ["plan", "count", "max"]],
];

// Django's X-Error-Code header (backend core/exceptions.py) for a whole-request error. The code
// decides the message, so a reworded English text keeps its translation; the text pattern of that
// key only supplies the numbers and words a message shows ({max}, {plan}).
const CODES: Record<string, ApiErrorKey> = {
  subscription_inactive: "subscriptionInactive", plan_limit_categories: "planLimitCategories",
  plan_limit_items: "planLimitItems", images_need_pro: "imagesNeedPro", colors_need_pro: "colorsNeedPro",
  logos_need_pro: "logosNeedPro", image_type: "imageType", image_too_large: "imageTooLarge",
  image_dimensions: "imageDimensions", image_upload_failed: "imageUploadFailed", qr_first: "qrFirst",
  not_found: "notFound", already_active: "alreadyActive", already_inactive: "alreadyInactive",
  downgrade_categories: "downgradeCategories", downgrade_items: "downgradeItems",
  reset_link_invalid: "resetLinkInvalid", renew_inactive: "renewInactive",
};

function valuesOf(match: RegExpExecArray, names: string[]) {
  return Object.fromEntries(
    names.map((name, i) => [name, /^\d+$/.test(match[i + 1]) ? Number(match[i + 1]) : match[i + 1]]),
  );
}

/**
 * One of Django's texts as a message. Numbers stay numbers, so plural rules can use them.
 * `code` is Django's X-Error-Code, when the text is the request's "detail".
 */
export function toApiMessage(text: string, code?: string | null): ApiMessage {
  const coded = code ? CODES[code] : undefined;
  if (coded) {
    const names = KNOWN.find(([, key]) => key === coded)?.[2] ?? [];
    if (names.length === 0) return { key: coded };
    // A message with numbers needs them: without a match, Django's own text is safer than a gap.
    const match = KNOWN.filter(([, key]) => key === coded).map(([pattern]) => pattern.exec(text)).find(Boolean);
    return match ? { key: coded, values: valuesOf(match, names) } : { text };
  }
  for (const [pattern, key, names = []] of KNOWN) {
    const match = pattern.exec(text);
    if (match) return names.length === 0 ? { key } : { key, values: valuesOf(match, names) };
  }
  return { text };
}

/**
 * Django's error body as a FormError. DRF answers {"detail": "..."} for the whole request, or field
 * errors such as {"name": {"ar": ["..."]}, "price": ["..."]}; nested fields become paths like "name.ar".
 * A body without any message (for example an HTML error page) becomes SERVER_ERROR.
 * `code` is the answer's X-Error-Code header; it belongs to "detail".
 */
export function toFormError(body: unknown, code?: string | null): FormError {
  const error: FormError = { form: null, fields: {} };
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (path === "" || path === "detail" || path === "non_field_errors") {
        error.form ??= toApiMessage(value, path === "detail" ? code : null);
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
