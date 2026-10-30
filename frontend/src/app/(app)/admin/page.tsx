import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Admin"))("title") };
}

// Placeholder for the Super Admin dashboard (system_design.md §4.1): stats, cafe list, billing.
export default function AdminPage() {
  const t = useTranslations("Admin");
  return <PageHeader title={t("title")} />;
}
