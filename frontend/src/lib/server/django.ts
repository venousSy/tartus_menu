import "server-only";

/**
 * Calls the Django API from the Next.js server. The browser never calls Django directly
 * (system_design.md §3.6): pages and BFF routes go through this function.
 * `path` starts after the API prefix, for example "/menu/tartus-coffee/".
 */
export async function djangoFetch(path: string, init?: RequestInit): Promise<Response> {
  const baseUrl = process.env.DJANGO_API_URL;
  if (!baseUrl) {
    throw new Error("DJANGO_API_URL is not set. Copy frontend/.env.example to frontend/.env.local.");
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
}
