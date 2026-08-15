/**
 * Programmatic navigation.
 *
 * `Router.goto()` renders the new route but does not touch the URL bar — a
 * documented gotcha in @lit-labs/router, not a bug here. The two have to be
 * paired or the back button restores a URL that no longer matches what is on
 * screen.
 *
 * The router instance lives on the app shell, so a view raises this event and
 * the shell performs the `goto`. Anything that can be an `<a href>` should be
 * one instead: the router already intercepts same-origin clicks, and a real
 * link supports middle-click, copy-link and the status bar preview.
 */

export const NAVIGATE_EVENT = "tl-navigate";

export function navigate(from: EventTarget, path: string): void {
  history.pushState({}, "", path);
  from.dispatchEvent(
    new CustomEvent<string>(NAVIGATE_EVENT, { detail: path, bubbles: true, composed: true }),
  );
}

declare global {
  interface HTMLElementEventMap {
    "tl-navigate": CustomEvent<string>;
  }
}
