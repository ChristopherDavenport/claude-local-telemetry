/**
 * Applies the jh-core dark theme.
 *
 * `jh-theme-dark.css` is scoped to a `.jh-theme-dark` class rather than to a
 * media query, so something has to put that class on the document. CSS cannot,
 * which is why this is script.
 *
 * The upside of the design system making that choice: the switch is a class,
 * so an explicit user preference can override the OS one whenever that is
 * wanted — `apply("dark")` is all it takes. Today it follows the OS and listens
 * for changes, so flipping appearance while the page is open works without a
 * reload.
 */

const CLASS = "jh-theme-dark";
const query = "(prefers-color-scheme: dark)";

export type Theme = "light" | "dark" | "system";

function apply(dark: boolean): void {
  document.documentElement.classList.toggle(CLASS, dark);
}

/** Follow the OS setting, and keep following it. */
export function startThemeSync(): void {
  const mq = window.matchMedia(query);
  apply(mq.matches);
  mq.addEventListener("change", (e) => apply(e.matches));
}

/** Escape hatch for an explicit preference; not wired to any control yet. */
export function setTheme(theme: Theme): void {
  apply(theme === "dark" || (theme === "system" && window.matchMedia(query).matches));
}
