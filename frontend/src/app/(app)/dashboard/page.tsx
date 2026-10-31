import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Dashboard"))("title") };
}

// Placeholder for the Cafe Owner dashboard (system_design.md §4.2): Categories, Items, QR codes, Settings.
export default function DashboardPage() {
  const t = useTranslations("Dashboard");
  return <PageHeader title={t("title")} signedIn />;
}
