// Light or dark theme of the customer menu (use_cases.md UC-GUEST-001 step 10, A8). Decided in the
// browser only, so the cached page stays the same for every customer.
//
// The guest's choice is the attribute data-theme="light" | "dark" on <html>. Without the attribute the
// menu follows the phone's setting: globals.css turns the `dark:` classes on through the
// prefers-color-scheme media query, with no JavaScript at all.

export type Theme = "light" | "dark";

/** The localStorage key of the guest's choice: one choice for the menus of every cafe, like the language. */
export const THEME_KEY = "menu-theme";

/**
 * Runs inline in <head>, before the page is first drawn, so a stored choice never shows the other
 * theme for a moment. Plain ES5 on purpose: it is not compiled. A browser that blocks storage
 * throws here; the menu then follows the phone's setting (A8).
 */
export const THEME_SCRIPT =
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});` +
  `if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

/** For useSyncExternalStore: told when the guest presses the button or the phone's setting changes. */
export function subscribeTheme(listener: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  listeners.add(listener);
  query.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    query.removeEventListener("change", listener);
  };
}

/** The theme the guest sees now: the stored choice, or else the phone's setting. */
export function readTheme(): Theme {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * Applies the guest's choice at once and stores it for the next visit. The attribute alone already
 * keeps it for this page, so when the browser blocks storage the choice lasts until the page is
 * closed (A8).
 */
export function writeTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage is blocked (A8): nothing more to do.
  }
  listeners.forEach((listener) => listener());
}
