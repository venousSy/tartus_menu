import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import { djangoFetch, forwardedForHeader } from "@/lib/server/django";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/server/session";

// Calls of Django's authenticated endpoints for the dashboards (system_design.md §3.6), shared by
// owner-api.ts and admin-api.ts. Django decides every permission; this module only carries the
// signed-in user's access token and turns Django's answers into what pages and actions need.

/**
 * A write's result: Django's answer on success (null for 204 No Content), or the error for the form
 * with Django's status (503 when Django could not be reached).
 */
export type WriteResult<T> = { ok: true; data: T } | { ok: false; status: number; error: FormError };

/** A Django answer a page cannot use. The dashboard's error screen shows it; callers may read `status` (403). */
export class ApiError extends Error {
  readonly status: number;
  readonly error: FormError;

  constructor(status: number, error: FormError) {
    super(`The Django API answered ${status}.`);
    this.status = status;
    this.error = error;
  }
}

export type ApiInit = { method?: "POST" | "PATCH" | "DELETE"; json?: object; form?: FormData };

/**
 * Calls one of Django's endpoints with the signed-in user's access token. `path` starts after
 * /api/v1. Returns null when Django cannot be reached; redirects when there is no session.
 */
export async function apiFetch(path: string, { method, json, form }: ApiInit = {}): Promise<Response | null> {
  const cookieStore = await cookies();
  const access = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!access) {
    // proxy.ts refreshes an expired access token before every dashboard request. If it is still
    // missing while a refresh cookie exists, Django could not be reached: never log anyone out for that.
    if (cookieStore.has(REFRESH_COOKIE)) return null;
    redirect("/login");
  }
  const forwardedFor = (await headers()).get("x-forwarded-for");
  let response: Response;
  try {
    response = await djangoFetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...forwardedForHeader(forwardedFor),
      },
      body: json ? JSON.stringify(json) : form, // FormData: fetch sets the multipart Content-Type itself
    });
  } catch {
    return null;
  }
  // Django no longer accepts the token, for example because the account was deactivated. redirect()
  // works by throwing, so it stays outside the try block above (Next docs).
  if (response.status === 401) redirect("/bff/auth/session-ended");
  return response;
}

/** A read for a page. Any answer other than 2xx throws ApiError, so the page shows its error screen. */
export async function apiGet<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response) throw new ApiError(503, SERVER_ERROR);
  if (!response.ok) throw new ApiError(response.status, await errorOf(response));
  return response.json();
}

/** A write from a Server Action. Errors are returned, not thrown, so the form can show them at its fields. */
export async function apiWrite<T>(path: string, init: ApiInit): Promise<WriteResult<T>> {
  const response = await apiFetch(path, init);
  if (!response) return { ok: false, status: 503, error: SERVER_ERROR };
  if (!response.ok) return { ok: false, status: response.status, error: await errorOf(response) };
  return { ok: true, data: response.status === 204 ? (null as T) : await response.json() };
}

/** Django's refusal as a FormError: its body, and the code of its X-Error-Code header. */
async function errorOf(response: Response): Promise<FormError> {
  return toFormError(await response.json().catch(() => null), response.headers.get("x-error-code"));
}
