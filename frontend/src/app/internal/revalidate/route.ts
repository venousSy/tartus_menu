import { createHash, timingSafeEqual } from "node:crypto";

import { revalidateTag } from "next/cache";

import { menuTag } from "@/lib/server/public-menu";

/**
 * POST /internal/revalidate: Django asks for fresh customer menus after a change it has saved
 * (system_design.md §3.5, use_cases.md GC 9). Header X-Revalidate-Secret, body { "slugs": [...] }.
 * Only Django can reach it: Nginx answers 404 for /internal/ (step 12), and proxy.ts never runs here.
 */
export async function POST(request: Request) {
  if (!isDjango(request.headers.get("x-revalidate-secret"))) {
    return Response.json({ detail: "Invalid revalidation secret." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const slugs: unknown = body?.slugs;
  if (!Array.isArray(slugs) || !slugs.every((slug) => typeof slug === "string" && slug !== "")) {
    return Response.json({ detail: 'Expected {"slugs": ["<cafe slug>", ...]}.' }, { status: 400 });
  }

  for (const slug of slugs) {
    // expire 0: the next visitor waits for the new menu. The recommended "max" would show the old
    // one to that visitor first (stale-while-revalidate), but GC 9 wants a change visible at once.
    revalidateTag(menuTag(slug), { expire: 0 });
  }
  return Response.json({ revalidated: true });
}

/**
 * True when the request carries the secret shared with Django. Without a configured secret every
 * call is refused (fail closed). Both values are hashed first, so timingSafeEqual compares equal
 * lengths and the time it takes says nothing about how much of a guess was right.
 */
function isDjango(received: string | null): boolean {
  const expected = process.env.FRONTEND_REVALIDATE_SECRET;
  if (!expected || !received) {
    return false;
  }
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}
