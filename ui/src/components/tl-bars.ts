/**
 * Horizontal bar breakdown — magnitude across named categories.
 *
 * One hue, not a categorical palette. The category is already named on the
 * axis, so colouring each bar differently would encode identity twice and
 * spend the categorical slots on nothing. Bars are directly labelled with their
 * value, which is what makes this readable without a legend.
 *
 * Horizontal rather than vertical because the labels are model ids, plugin
 * names and working directories — long text that would have to be rotated on a
 * column chart.
 *
 * Built from HTML rather than SVG: a bar chart is a list of proportional
 * lengths, and HTML gives text wrapping, ellipsis and focusability for free.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface Bar {
  label: string;
  value: number | null;
  /** Shown in the hover layer; the value itself is already on the bar. */
  detail?: string;
  /** Passed back on `bar-click`. */
  id?: string;
}

@customElement("tl-bars")
export class TlBars extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
    }

    ol {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      /* The 2px surface gap between adjacent marks. */
      gap: 2px;
    }

    li {
      display: grid;
      grid-template-columns: minmax(90px, 22%) 1fr auto;
      align-items: center;
      gap: var(--jh-size-300);
      padding: 2px var(--jh-size-100);
      border-radius: var(--jh-border-radius-50);
    }

    li:hover,
    li:focus-within {
      background: var(--jh-color-container-secondary-hover);
    }

    li[data-clickable] {
      cursor: pointer;
    }

    .name {
      font-size: var(--jh-font-size-300);
      color: var(--jh-color-content-primary-enabled);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .track {
      position: relative;
      height: 14px;
      min-width: 0;
    }

    .fill {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      background: var(--tl-sequential);
      /* Square at the baseline, 4px rounded at the data end. */
      border-radius: 0 4px 4px 0;
      min-width: 2px;
    }

    /* A null is not a zero-length bar — it is no bar, plus a mark saying so. */
    .absent {
      font-size: var(--jh-font-size-250);
      color: var(--jh-color-content-secondary-enabled);
      font-style: italic;
    }

    .value {
      font-size: var(--jh-font-size-300);
      font-variant-numeric: tabular-nums;
      color: var(--jh-color-content-primary-enabled);
      white-space: nowrap;
    }

    .tip {
      position: absolute;
      z-index: 5;
      pointer-events: none;
      background: var(--jh-color-container-primary-enabled);
      color: var(--jh-color-content-primary-enabled);
      border: 1px solid var(--jh-color-divider-primary);
      border-radius: var(--jh-border-radius-100);
      box-shadow: var(--jh-shadow-200);
      padding: var(--jh-size-200) var(--jh-size-250);
      font-size: var(--jh-font-size-300);
      max-width: 320px;
      transform: translate(-50%, -100%);
    }

    .tip-label {
      font-weight: 500;
      overflow-wrap: anywhere;
    }

    .tip-detail {
      color: var(--jh-color-content-secondary-enabled);
      margin-top: 2px;
    }
  `;

  @property({ attribute: false }) data: Bar[] = [];
  /** Renders the value at the end of each bar. */
  @property({ attribute: false }) format: (v: number | null) => string = (v) => String(v ?? "—");
  @property({ type: Boolean }) clickable = false;

  @state() private tip: { bar: Bar; x: number; y: number } | null = null;

  private get max(): number {
    return this.data.reduce((m, d) => Math.max(m, d.value ?? 0), 0);
  }

  private show(e: PointerEvent, bar: Bar) {
    const host = this.getBoundingClientRect();
    const row = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.tip = {
      bar,
      x: e.clientX - host.left,
      y: row.top - host.top - 6,
    };
  }

  override render() {
    const max = this.max;
    return html`
      <ol>
        ${this.data.map((d) => {
          const pct = max > 0 && d.value != null ? Math.max((d.value / max) * 100, 0.5) : 0;
          return html`
            <li
              ?data-clickable=${this.clickable}
              tabindex=${this.clickable ? "0" : "-1"}
              @pointermove=${(e: PointerEvent) => this.show(e, d)}
              @pointerleave=${() => (this.tip = null)}
              @click=${() => this.emit(d)}
              @keydown=${(e: KeyboardEvent) => {
                if (this.clickable && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  this.emit(d);
                }
              }}
            >
              <span class="name" title=${d.label}>${d.label}</span>
              <span class="track">
                ${d.value == null
                  ? html`<span class="absent">not recorded</span>`
                  : html`<span class="fill" style="width:${pct}%"></span>`}
              </span>
              <span class="value">${this.format(d.value)}</span>
            </li>
          `;
        })}
      </ol>
      ${this.tip
        ? html`
            <div class="tip" style="left:${this.tip.x}px; top:${this.tip.y}px">
              <div class="tip-label">${this.tip.bar.label}</div>
              <div>${this.format(this.tip.bar.value)}</div>
              ${this.tip.bar.detail
                ? html`<div class="tip-detail">${this.tip.bar.detail}</div>`
                : nothing}
            </div>
          `
        : nothing}
    `;
  }

  private emit(bar: Bar) {
    if (!this.clickable) return;
    this.dispatchEvent(
      new CustomEvent<Bar>("bar-click", { detail: bar, bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-bars": TlBars;
  }
}
