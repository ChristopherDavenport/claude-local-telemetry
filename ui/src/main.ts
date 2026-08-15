/**
 * Entry point.
 *
 * The theme class goes on before the shell renders, so the first paint is
 * already the right appearance rather than a light flash on a dark desktop.
 *
 * The polyfill import is conditional and dynamic on purpose: `URLPattern` is
 * what @lit-labs/router matches with, Chromium has shipped it for years, and
 * loading a polyfill everywhere to cover the browsers that haven't would put
 * bytes in front of every reader for a minority case. It must resolve *before*
 * the router module is evaluated, which is why the shell is imported
 * dynamically underneath it rather than at the top of the file.
 */

import "./theme.css";
import { startThemeSync } from "./theme.js";

startThemeSync();

if (!("URLPattern" in globalThis)) {
  await import("urlpattern-polyfill");
}

await import("./app-shell.js");
