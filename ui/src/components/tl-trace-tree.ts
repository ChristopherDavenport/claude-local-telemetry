/**
 * The observability tree: nested spans with events woven in.
 *
 * Two kinds of node, encoded three ways so identity never rests on colour
 * alone — a span is a **bar** with a width, an event is a **diamond** at a
 * point, and each carries its own label and duration/offset column. A span has
 * a duration; an event is instantaneous, so its right-hand column shows its
 * offset from the start of the trace instead. Rendering an event as a
 * zero-width bar would put it on the same visual scale as a span and imply a
 * duration it does not have.
 *
 * Bars are positioned against the whole trace's window, so a child that starts
 * late is visibly late. That offset is the only reason to draw this rather than
 * an indented list of durations.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { TraceNode } from "../api.js";
import { ms } from "../format.js";

interface Flat {
  node: TraceNode;
  depth: number;
  start: number;
  end: number;
  path: string;
}

const epoch = (ts: string): number => {
  const n = Date.parse(/[Z+]|-\d\d:\d\d$/.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(n) ? 0 : n;
};

const spanOf = (n: TraceNode): number => (n.kind === "span" ? (n.duration_ms ?? 0) : 0);

@customElement("tl-trace-tree")
export class TlTraceTree extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    ol {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li {
      display: grid;
      grid-template-columns: minmax(200px, 36%) 1fr auto;
      align-items: center;
      gap: var(--jh-size-300);
      padding: 3px var(--jh-size-200);
      border-radius: var(--jh-border-radius-50);
      font-size: var(--jh-font-size-300);
    }

    li:hover {
      background: var(--jh-color-container-secondary-hover);
    }

    .name {
      display: flex;
      align-items: center;
      gap: var(--jh-size-150);
      min-width: 0;
    }

    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    .label:focus-visible {
      outline: 2px solid var(--jh-color-interactive-focus-outer);
    }

    /* Events read as annotations on the spans, not as peers of them. */
    li[data-kind="event"] .label {
      color: var(--jh-color-content-secondary-enabled);
      font-family: var(--jh-font-family-mono);
      font-size: var(--jh-font-size-250);
    }

    .toggle {
      all: unset;
      cursor: pointer;
      width: 14px;
      flex: none;
      color: var(--jh-color-content-secondary-enabled);
      font-size: 10px;
    }

    .toggle:focus-visible {
      outline: 2px solid var(--jh-color-interactive-focus-outer);
    }

    .leaf {
      width: 14px;
      flex: none;
    }

    .track {
      position: relative;
      height: 12px;
      background: var(--jh-color-container-secondary-enabled);
      border-radius: var(--jh-border-radius-50);
      min-width: 0;
    }

    .bar {
      position: absolute;
      inset-block: 0;
      background: var(--tl-sequential);
      border-radius: 3px;
      min-width: 2px;
    }

    /* A point in time: a rotated square, centred on its instant. */
    .tick {
      position: absolute;
      top: 50%;
      width: 8px;
      height: 8px;
      margin-left: -4px;
      background: var(--tl-series-4);
      transform: translateY(-50%) rotate(45deg);
      border-radius: 1px;
    }

    .dur {
      font-variant-numeric: tabular-nums;
      color: var(--jh-color-content-secondary-enabled);
      white-space: nowrap;
    }

    .src {
      font-size: var(--jh-font-size-250);
      color: var(--jh-color-content-secondary-enabled);
      border: 1px solid var(--jh-color-divider-primary);
      border-radius: var(--jh-border-radius-pill);
      padding: 0 6px;
      flex: none;
    }

    .attrs {
      grid-column: 1 / -1;
      margin: var(--jh-size-100) 0 var(--jh-size-250);
      padding: var(--jh-size-250);
      background: var(--jh-color-container-secondary-enabled);
      border-radius: var(--jh-border-radius-100);
      font-family: var(--jh-font-family-mono);
      font-size: var(--jh-font-size-250);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 280px;
      overflow: auto;
    }

    .legend {
      display: flex;
      gap: var(--jh-size-400);
      margin-bottom: var(--jh-size-250);
      font-size: var(--jh-font-size-300);
      color: var(--jh-color-content-secondary-enabled);
    }

    .legend span {
      display: inline-flex;
      align-items: center;
      gap: var(--jh-size-150);
    }

    .key-bar {
      width: 16px;
      height: 8px;
      border-radius: 2px;
      background: var(--tl-sequential);
    }

    .key-tick {
      width: 8px;
      height: 8px;
      background: var(--tl-series-4);
      transform: rotate(45deg);
      border-radius: 1px;
    }
  `;

  @property({ attribute: false }) tree: TraceNode[] = [];

  @state() private collapsed = new Set<string>();
  @state() private opened: string | null = null;

  /** Depth-first, skipping the subtrees of collapsed nodes. */
  private get flat(): Flat[] {
    const out: Flat[] = [];
    const walk = (nodes: TraceNode[], depth: number, prefix: string) => {
      nodes.forEach((node, i) => {
        const path = `${prefix}/${i}`;
        const start = epoch(node.ts);
        out.push({ node, depth, start, end: start + spanOf(node), path });
        if (node.children.length && !this.collapsed.has(path)) {
          walk(node.children, depth + 1, path);
        }
      });
    };
    walk(this.tree, 0, "");
    return out;
  }

  /** Window over every node, including collapsed ones — otherwise expanding a
   *  node would rescale every bar above it. */
  private window(): { lo: number; span: number } {
    let lo = Infinity;
    let hi = -Infinity;
    const scan = (nodes: TraceNode[]) => {
      for (const n of nodes) {
        const a = epoch(n.ts);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a + spanOf(n));
        scan(n.children);
      }
    };
    scan(this.tree);
    if (!Number.isFinite(lo)) return { lo: 0, span: 1 };
    return { lo, span: Math.max(hi - lo, 1) };
  }

  override render() {
    const rows = this.flat;
    if (!rows.length) return nothing;
    const { lo, span } = this.window();
    const hasEvents = rows.some((r) => r.node.kind === "event");

    return html`
      ${hasEvents
        ? html`
            <div class="legend">
              <span><span class="key-bar"></span>span (duration)</span>
              <span><span class="key-tick"></span>event (instant)</span>
            </div>
          `
        : nothing}
      <ol>
        ${rows.map((r) => this.row(r, lo, span))}
      </ol>
    `;
  }

  private row(r: Flat, lo: number, span: number) {
    const isSpan = r.node.kind === "span";
    const left = ((r.start - lo) / span) * 100;
    const width = Math.max(((r.end - r.start) / span) * 100, 0.4);
    const hasKids = r.node.children.length > 0;
    const isCollapsed = this.collapsed.has(r.path);

    return html`
      <li data-kind=${r.node.kind}>
        <span class="name" style="padding-inline-start:${r.depth * 14}px">
          ${hasKids
            ? html`
                <button
                  class="toggle"
                  type="button"
                  aria-expanded=${!isCollapsed}
                  title=${isCollapsed ? "Expand" : "Collapse"}
                  @click=${() => this.toggleNode(r.path)}
                >
                  ${isCollapsed ? "▶" : "▼"}
                </button>
              `
            : html`<span class="leaf"></span>`}
          <span
            class="label"
            title=${r.node.name}
            role="button"
            tabindex="0"
            @click=${() => this.toggleAttrs(r.path)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.toggleAttrs(r.path);
              }
            }}
            >${r.node.name}</span
          >
          ${!isSpan && r.node.kind === "event" && r.node.source
            ? html`<span class="src">${r.node.source}</span>`
            : nothing}
        </span>

        <span class="track">
          ${isSpan
            ? html`<span class="bar" style="left:${left}%; width:${width}%"></span>`
            : html`<span
                class="tick"
                style="left:${left}%"
                title="+${ms(r.start - lo)} from trace start"
              ></span>`}
        </span>

        <span class="dur">
          ${isSpan && r.node.kind === "span"
            ? ms(r.node.duration_ms)
            : html`+${ms(r.start - lo)}`}
        </span>
      </li>
      ${this.opened === r.path
        ? html`<div class="attrs">${JSON.stringify(r.node.attrs, null, 2)}</div>`
        : nothing}
    `;
  }

  private toggleNode(path: string) {
    const next = new Set(this.collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.collapsed = next; // new identity, or Lit won't see the change
  }

  private toggleAttrs(path: string) {
    this.opened = this.opened === path ? null : path;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-trace-tree": TlTraceTree;
  }
}
