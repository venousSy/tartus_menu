import type { MetadataRoute } from "next";

import { BRAND_COLOR } from "@/app/brand-mark";
import { pickText } from "@/lib/i18n";
import { getPublicMenu } from "@/lib/server/public-menu";

/**
 * GET /menu/<slug>/manifest.webmanifest: the web app manifest of one cafe, so "Add to Home Screen"
 * installs that cafe's menu with its name and color. Next's manifest.ts works only at the app root,
 * where a single manifest would open "/" for every cafe. It reads the cached menu, so Django's
 * revalidation (tag menu:<slug>) refreshes the name and color too.
 */
export async function GET(_request: Request, { params }: RouteContext<"/menu/[slug]/manifest.webmanifest">) {
  const { slug } = await params;
  const menu = await getPublicMenu(slug);
  if (!menu) {
    return Response.json({ detail: "Not found." }, { status: 404 });
  }

  const home = `/menu/${encodeURIComponent(slug)}`;
  const manifest: MetadataRoute.Manifest = {
    name: pickText(menu.cafe.name, "ar"),
    lang: "ar",
    dir: "rtl",
    start_url: home, // no ?table=N: an installed menu belongs to the cafe, not to one table
    scope: home,
    display: "standalone",
    background_color: "#fafaf9", // bg-stone-50, the menu page's background (the launch screen)
    theme_color: menu.cafe.primary_color || BRAND_COLOR, // "" = no branding on this plan (GC 7)
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png" },
      { src: "/icon/512", sizes: "512x512", type: "image/png" },
      // The same picture: the cup stays inside the circle Android may cut out of a "maskable" icon.
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return Response.json(manifest, { headers: { "Content-Type": "application/manifest+json" } });
}
