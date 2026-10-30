import { LanguageSwitch } from "./language-switch";

/** The top bar of every signed-in page: the page title and the language switch. */
export function PageHeader({ title }: { title: string }) {
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <h1 className="text-xl font-bold">{title}</h1>
        <LanguageSwitch />
      </div>
    </header>
  );
}
