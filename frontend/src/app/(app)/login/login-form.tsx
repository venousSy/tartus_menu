"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { HOME } from "@/lib/roles";

// What went wrong, as a message key: the text is chosen when the form renders, so it follows a
// language switch. `seconds` is the wait Django names in a 429 answer. `email` refills the field:
// React resets a form after its action, and only the password should be typed again.
type LoginError = "wrongCredentials" | "missingFields" | "throttled" | "serverError";
type State = { error: LoginError | null; seconds?: number; email?: string };

/**
 * Sends the form to the BFF route /bff/auth/login (UC-AUTH-001). The tokens stay in HttpOnly
 * cookies; the answer is { role } on success, or Django's own error passed through.
 */
async function logIn(formData: FormData): Promise<{ role: string } | State> {
  let response: Response;
  try {
    response = await fetch("/bff/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: formData.get("email"), password: formData.get("password") }),
    });
  } catch {
    return { error: "serverError" }; // no network, or the server is down
  }
  if (response.ok) return response.json();
  if (response.status === 401) return { error: "wrongCredentials" }; // A1, A2: wrong or inactive account
  if (response.status === 400) return { error: "missingFields" }; // A3
  if (response.status === 429) {
    // A4: "Request was throttled. Expected available in N seconds."
    const { detail = "" } = await response.json().catch(() => ({}));
    return { error: "throttled", seconds: Number(/(\d+) second/.exec(detail)?.[1] ?? 60) };
  }
  return { error: "serverError" };
}

/** The login form of both roles. On success it opens the role's home page. */
export function LoginForm() {
  const t = useTranslations("Login");
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (_previous: State, formData: FormData): Promise<State> => {
      const result = await logIn(formData);
      if ("role" in result) {
        router.replace(HOME[result.role as keyof typeof HOME] ?? "/login");
        return { error: null };
      }
      return { ...result, email: String(formData.get("email") ?? "") };
    },
    { error: null },
  );

  return (
    <form action={formAction} className="mx-auto mt-12 flex max-w-sm flex-col gap-4 px-4">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t("email")}</span>
        <input name="email" type="email" required autoComplete="username" dir="ltr" defaultValue={state.email}
          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{t("password")}</span>
        <input name="password" type="password" required autoComplete="current-password" dir="ltr"
          className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" />
      </label>
      {state.error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          {t(state.error, { seconds: state.seconds ?? 0 })}
        </p>
      )}
      <button type="submit" disabled={pending}
        className="min-h-11 rounded-lg bg-primary font-semibold text-on-primary disabled:opacity-60">
        {pending ? t("submitting") : t("submit")}
      </button>
    </form>
  );
}
