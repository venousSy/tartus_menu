import { LanguageSwitch } from "./language-switch";
import { LogoutButton } from "./logout-button";

/** The top bar of the login page and the dashboards: the title, the language switch, and logout once signed in. */
export function PageHeader({ title, signedIn = false }: { title: string; signedIn?: boolean }) {
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <h1 className="text-xl font-bold">{title}</h1>
        <div className="flex items-center gap-2">
          <LanguageSwitch />
          {signedIn && <LogoutButton />}
        </div>
      </div>
    </header>
  );
}
