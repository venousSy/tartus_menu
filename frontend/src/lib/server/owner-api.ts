import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { type FormError, SERVER_ERROR, toFormError } from "@/lib/api-errors";
import type { BilingualText } from "@/lib/i18n";
import { djangoFetch } from "@/lib/server/django";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/server/session";

/** GET /api/v1/dashboard/settings/ (UC-OWNER-014): the cafe profile, its plan and its subscription state. */
export type CafeSettings = {
  name: BilingualText;
  slug: string;
  primary_color: string; // stored value, even when the plan hides it from customers (GC 7)
  logo_url: string;
  is_active: boolean;
  plan: {
    name: string; // the plan code: "basic" or "pro"
    max_categories: number | null; // null = unlimited
    max_items: number | null;
    allows_images: boolean;
    allows_branding: boolean;
  };
};

/** A category of GET /api/v1/dashboard/categories/ (UC-OWNER-012), hidden ones included. */
export type Category = { id: number; name: BilingualText; sort_order: number; is_visible: boolean };

/** A write's result: Django's answer on success (null for 204 No Content), or the error for the form. */
export type WriteResult<T> = { ok: true; data: T } | { ok: false; error: FormError };

/** A Django answer a page cannot use. The dashboard's error screen shows it; getSettings reads `status` (403). */
export class OwnerApiError extends Error {
  readonly status: number;
  readonly error: FormError;

  constructor(status: number, error: FormError) {
    super(`The owner API answered ${status}.`);
    this.status = status;
    this.error = error;
  }
}

export type OwnerInit = { method?: "POST" | "PATCH" | "DELETE"; json?: object; form?: FormData };

/**
 * Calls one of Django's owner endpoints with the signed-in user's access token (system_design.md
 * §3.6). Django decides every permission; this module only carries the token. `path` starts after
 * /api/v1. Returns null when Django cannot be reached; redirects when there is no session.
 */
async function ownerFetch(path: string, { method, json, form }: OwnerInit = {}): Promise<Response | null> {
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
        ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
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

/** A read for a page. Any answer other than 2xx throws OwnerApiError, so the page shows its error screen. */
async function ownerGet<T>(path: string): Promise<T> {
  const response = await ownerFetch(path);
  if (!response) throw new OwnerApiError(503, SERVER_ERROR);
  if (!response.ok) throw new OwnerApiError(response.status, toFormError(await response.json().catch(() => null)));
  return response.json();
}

/** A write from a Server Action. Errors are returned, not thrown, so the form can show them at its fields. */
export async function ownerWrite<T>(path: string, init: OwnerInit): Promise<WriteResult<T>> {
  const response = await ownerFetch(path, init);
  if (!response) return { ok: false, error: SERVER_ERROR };
  if (!response.ok) return { ok: false, error: toFormError(await response.json().catch(() => null)) };
  return { ok: true, data: response.status === 204 ? (null as T) : await response.json() };
}

/**
 * The cafe's settings (UC-OWNER-014). cache(): the layout and the page of one request share one call.
 * It is also the role re-check behind proxy.ts. This is the only owner endpoint without the
 * active-cafe check (GC 5), so its only 403 is the role check: the account is no longer a Cafe
 * Owner with a cafe, but the role claim in its token still says so. Django writes that claim at
 * login and every refresh copies it, so only a new login fixes it: the session ends here.
 */
export const getSettings = cache(async (): Promise<CafeSettings> => {
  try {
    return await ownerGet<CafeSettings>("/dashboard/settings/");
  } catch (error) {
    if (error instanceof OwnerApiError && error.status === 403) redirect("/bff/auth/session-ended");
    throw error; // also the redirects of ownerFetch, which work by throwing
  }
});

/** The cafe's categories in menu order (UC-OWNER-012). Django answers 403 for an inactive cafe (GC 5). */
export function getCategories(): Promise<Category[]> {
  return ownerGet<Category[]>("/dashboard/categories/");
}
