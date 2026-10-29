import type { BilingualText } from "@/lib/i18n";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";

/**
 * A full-screen message in Arabic and English, for the screens that have no menu to switch
 * languages on: "Menu not found" (UC-GUEST-001 A1) and "temporarily unavailable" (UC-GUEST-002).
 */
export function Notice({ title, messageKey }: { title?: BilingualText; messageKey: "notFound" | "unavailable" }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-50 px-6 text-center text-stone-900">
      {title?.ar && <h1 dir="auto" className="text-2xl font-bold">{title.ar}</h1>}
      {title?.en && <p lang="en" dir="auto" className="-mt-2 text-lg text-stone-600">{title.en}</p>}
      <p className="text-lg">{ar.Menu[messageKey]}</p>
      <p lang="en" dir="ltr" className="text-stone-600">{en.Menu[messageKey]}</p>
    </main>
  );
}
