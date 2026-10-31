import type { Metadata } from "next";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "../page-header";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("Login"))("title") };
}

// Placeholder: the login form comes with the BFF login route. Both roles log in here.
export default function LoginPage() {
  const t = useTranslations("Login");
  return <PageHeader title={t("title")} />;
}
