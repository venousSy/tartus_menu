import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { pickText } from "@/lib/i18n";
import { getPublicMenu } from "@/lib/server/public-menu";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import { MenuView } from "./menu-view";
import { Notice } from "./notice";

type Props = PageProps<"/menu/[slug]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const menu = await getPublicMenu((await params).slug);
  return {
    title: menu ? pickText(menu.cafe.name, "ar") : undefined,
    // Customer pages are never indexed: no price scraping (system_design.md §7).
    robots: { index: false, follow: false },
  };
}

// UC-GUEST-001. `params` is awaited inside <Suspense>, so Next.js sends the static App Shell at
// once, renders each cafe's page on its first visit, and serves the cached result afterwards.
export default function MenuPage({ params }: Props) {
  return (
    <Suspense>
      <Menu params={params} />
    </Suspense>
  );
}

async function Menu({ params }: Pick<Props, "params">) {
  const { slug } = await params;
  const menu = await getPublicMenu(slug);
  if (!menu) {
    notFound(); // A1: unknown slug
  }
  if (!menu.cafe.is_active) {
    return <Notice title={menu.cafe.name} messageKey="unavailable" />; // A2 / UC-GUEST-002
  }
  // Only the "Menu" texts go to the browser, as props, not the whole message files.
  return (
    <MenuView
      menu={menu}
      messages={{ ar: ar.Menu, en: en.Menu }}
      manifestHref={`/menu/${encodeURIComponent(slug)}/manifest.webmanifest`}
    />
  );
}
