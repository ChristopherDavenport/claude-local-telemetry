/**
 * App shell — nav, and the one Router on the page.
 *
 * `@lit-labs/router` is Lit Labs and pre-1.0; it is here because it is ~3 KB
 * and matches with the platform's own `URLPattern` rather than shipping a
 * parser. Exactly one `Router` may exist, since it installs global click and
 * popstate listeners — every nested case would need `Routes` instead.
 *
 * Deep links work because the API server falls back to `index.html` for
 * unknown paths, and Vite's dev server does the same. Both halves are
 * required: without the server side, a refresh on /sessions/abc is a 404.
 */

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Router } from "@lit-labs/router";
import "@jack-henry/jh-ui/components/divider/divider.js";

import { NAVIGATE_EVENT } from "./navigate.js";

import "./views/view-overview.js";
import "./views/view-cost.js";
import "./views/view-sessions.js";
import "./views/view-session.js";
import "./views/view-tools.js";
import "./views/view-plugins.js";
import "./views/view-hooks.js";
import "./views/view-query.js";
import "./views/view-traces.js";
import "./views/view-trace.js";

interface NavItem {
  href: string;
  label: string;
  /** Also mark active for any path under this prefix. */
  prefix?: string;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/cost", label: "Cost" },
  { href: "/sessions", label: "Sessions", prefix: "/sessions" },
  { href: "/traces", label: "Traces", prefix: "/trace" },
  { href: "/tools", label: "Tools" },
  { href: "/plugins", label: "Plugins" },
  { href: "/hooks", label: "Hooks" },
  { href: "/query", label: "Query" },
];

@customElement("tl-app")
export class TlApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }

    header {
      background: var(--jh-color-container-primary-enabled);
      border-bottom: 1px solid var(--jh-color-divider-primary);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .bar {
      max-width: var(--tl-max-width);
      margin: 0 auto;
      padding: var(--jh-size-300) var(--jh-size-500);
      display: flex;
      align-items: center;
      gap: var(--jh-size-500);
      flex-wrap: wrap;
    }

    .brand {
      font-weight: 500;
      font-size: var(--jh-font-size-400);
      color: var(--jh-color-content-primary-enabled);
      text-decoration: none;
      white-space: nowrap;
    }

    .brand small {
      display: block;
      font-weight: 400;
      font-size: var(--jh-font-size-250);
      color: var(--jh-color-content-secondary-enabled);
    }

    nav {
      display: flex;
      gap: var(--jh-size-100);
      flex-wrap: wrap;
    }

    nav a {
      display: inline-block;
      padding: var(--jh-size-200) var(--jh-size-300);
      border-radius: var(--jh-border-radius-100);
      text-decoration: none;
      font-size: var(--jh-font-size-350);
      color: var(--jh-color-content-secondary-enabled);
    }

    nav a:hover {
      background: var(--jh-color-container-secondary-hover);
      color: var(--jh-color-content-primary-enabled);
    }

    nav a[aria-current="page"] {
      background: var(--jh-color-container-primary-selected);
      color: var(--jh-color-content-brand-enabled);
      font-weight: 500;
    }

    main {
      max-width: var(--tl-max-width);
      margin: 0 auto;
      padding: var(--jh-size-500);
    }

    .missing {
      padding: var(--jh-size-800) 0;
      text-align: center;
      color: var(--jh-color-content-secondary-enabled);
    }
  `;

  /** Bumped on every navigation so `render` re-evaluates the active link. */
  @state() private tick = 0;

  private router = new Router(
    this,
    [
      { path: "/", render: () => html`<view-overview></view-overview>` },
      { path: "/cost", render: () => html`<view-cost></view-cost>` },

      // Both spellings: URLPattern treats the trailing slash as significant, and
      // the back link from a session detail uses one.
      { path: "/sessions", render: () => html`<view-sessions></view-sessions>` },
      { path: "/sessions/", render: () => html`<view-sessions></view-sessions>` },
      {
        path: "/sessions/:id",
        render: ({ id }) => html`<view-session .sessionId=${id ?? ""}></view-session>`,
      },

      { path: "/tools", render: () => html`<view-tools></view-tools>` },
      { path: "/plugins", render: () => html`<view-plugins></view-plugins>` },
      { path: "/hooks", render: () => html`<view-hooks></view-hooks>` },
      { path: "/query", render: () => html`<view-query></view-query>` },

      { path: "/traces", render: () => html`<view-traces></view-traces>` },
      { path: "/traces/", render: () => html`<view-traces></view-traces>` },
      {
        path: "/trace/:id",
        render: ({ id }) => html`<view-trace .traceId=${id ?? ""}></view-trace>`,
      },
      // A session's event timeline is the same tree without a trace id.
      {
        path: "/trace/session/:id",
        render: ({ id }) => html`<view-trace .sessionId=${id ?? ""}></view-trace>`,
      },
    ],
    {
      fallback: {
        render: () => html`
          <div class="missing">
            <p>No such page.</p>
            <p><a href="/">Back to the overview</a></p>
          </div>
        `,
      },
    },
  );

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(NAVIGATE_EVENT, this.onNavigate as EventListener);
    // The Router handles popstate itself, but nothing tells *us* to re-render
    // the active-link state, and there is no route-changed event to subscribe to.
    window.addEventListener("popstate", this.onPopState);
  }

  override disconnectedCallback() {
    this.removeEventListener(NAVIGATE_EVENT, this.onNavigate as EventListener);
    window.removeEventListener("popstate", this.onPopState);
    super.disconnectedCallback();
  }

  private onPopState = () => {
    this.tick++;
  };

  private onNavigate = (e: CustomEvent<string>) => {
    // `navigate()` has already pushed the URL; goto renders it.
    void this.router.goto(e.detail);
    this.tick++;
  };

  private isActive(item: NavItem): boolean {
    const path = location.pathname;
    // href first: "Traces" links to /traces but owns the /trace/:id prefix, and
    // /traces does not start with "/trace/".
    if (path === item.href) return true;
    if (item.prefix) return path === item.prefix || path.startsWith(`${item.prefix}/`);
    return false;
  }

  override render() {
    // Referenced so the active-link computation re-runs after navigation.
    this.tick;

    return html`
      <header>
        <div class="bar">
          <a class="brand" href="/">
            claude-local-telemetry
            <small>local observability for Claude Code</small>
          </a>
          <nav>
            ${NAV.map(
              (n) => html`
                <a
                  href=${n.href}
                  aria-current=${this.isActive(n) ? "page" : "false"}
                  @click=${() => queueMicrotask(() => this.tick++)}
                  >${n.label}</a
                >
              `,
            )}
          </nav>
        </div>
      </header>
      <main>${this.router.outlet()}</main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-app": TlApp;
  }
}
