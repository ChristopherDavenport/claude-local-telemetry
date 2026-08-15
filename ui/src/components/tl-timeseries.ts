/**
 * Stacked columns over time.
 *
 * Change-over-time with a composition — that is the one job this chart does.
 * Tokens split four ways (input, output, cache read, cache creation) is the
 * canonical case, and it is also why the series palette exists.
 *
 * **One axis, always.** Cost and tokens are different scales and never share a
 * plot; the cost view renders a second chart rather than a second y-axis. A
 * dual-axis chart lets the author imply any correlation they like by choosing
 * the scales, which is why it is the one form ruled out outright.
 *
 * SVG here rather than HTML, because a shared y-scale across columns is
 * genuinely geometric. Width comes from a ResizeObserver instead of a viewBox
 * stretch, so the tick text stays at its real size at every container width.
 */

import { LitElement, html, css, svg, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface Series {
  label: string;
  /** A CSS custom property reference, e.g. `var(--tl-series-1)`. */
  color: string;
}

export interface Bucket {
  /** X label, already formatted. */
  label: string;
  /** One value per series, same order as `series`. */
  values: number[];
}

const PAD = { top: 8, right: 8, bottom: 22, left: 56 };
const HEIGHT = 240;
const SEG_GAP = 2;
const BAR_GAP = 2;

/** Round to 1/2/5 × 10ⁿ so the axis reads in human numbers. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

/** A rect with only its top corners rounded — the data end of a column. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

@customElement("tl-timeseries")
export class TlTimeseries extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--jh-size-300);
      margin-bottom: var(--jh-size-250);
      font-size: var(--jh-font-size-300);
      /* Legend text wears ink, never the series colour. */
      color: var(--jh-color-content-secondary-enabled);
    }

    .legend span {
      display: inline-flex;
      align-items: center;
      gap: var(--jh-size-150);
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex: none;
    }

    svg {
      display: block;
      width: 100%;
    }

    .grid line {
      stroke: var(--tl-grid);
      stroke-width: 1;
      shape-rendering: crispEdges;
    }

    .tick {
      fill: var(--tl-axis-ink);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .crosshair {
      stroke: var(--jh-color-content-secondary-enabled);
      stroke-width: 1;
      stroke-dasharray: 3 3;
      opacity: 0.6;
    }

    .hit {
      fill: transparent;
    }

    .tip {
      position: absolute;
      z-index: 5;
      pointer-events: none;
      background: var(--jh-color-container-primary-enabled);
      border: 1px solid var(--jh-color-divider-primary);
      border-radius: var(--jh-border-radius-100);
      box-shadow: var(--jh-shadow-200);
      padding: var(--jh-size-250);
      font-size: var(--jh-font-size-300);
      min-width: 170px;
      transform: translate(-50%, -100%);
    }

    .tip h4 {
      margin: 0 0 var(--jh-size-150);
      font-size: var(--jh-font-size-300);
      font-weight: 500;
    }

    .tip dl {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 2px var(--jh-size-200);
      margin: 0;
      align-items: center;
    }

    .tip dt {
      display: contents;
      color: var(--jh-color-content-secondary-enabled);
    }

    .tip .v {
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: var(--jh-color-content-primary-enabled);
    }

    .tip .total {
      margin-top: var(--jh-size-150);
      padding-top: var(--jh-size-150);
      border-top: 1px solid var(--jh-color-divider-secondary);
      display: flex;
      justify-content: space-between;
      gap: var(--jh-size-300);
      font-variant-numeric: tabular-nums;
    }
  `;

  @property({ attribute: false }) series: Series[] = [];
  @property({ attribute: false }) buckets: Bucket[] = [];
  @property({ attribute: false }) format: (v: number) => string = (v) => String(v);
  @property({ type: String }) label = "Value over time";

  @state() private width = 720;
  @state() private hover: number | null = null;

  private ro?: ResizeObserver;

  override connectedCallback() {
    super.connectedCallback();
    this.ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      // Sub-pixel churn would re-render on every scroll in some browsers.
      if (w > 0 && Math.abs(w - this.width) > 1) this.width = w;
    });
    this.ro.observe(this);
  }

  override disconnectedCallback() {
    this.ro?.disconnect();
    super.disconnectedCallback();
  }

  private get totals(): number[] {
    return this.buckets.map((b) => b.values.reduce((a, v) => a + (v || 0), 0));
  }

  override render() {
    const n = this.buckets.length;
    if (!n) return nothing;

    const innerW = Math.max(this.width - PAD.left - PAD.right, 40);
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const totals = this.totals;
    const max = Math.max(...totals, 0);
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
    const slot = innerW / n;
    const barW = Math.max(slot - BAR_GAP, 1);

    // Label every bucket only when they fit; otherwise thin to ~8.
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 64))));

    return html`
      ${this.series.length > 1
        ? html`
            <div class="legend">
              ${this.series.map(
                (s) => html`
                  <span>
                    <span class="swatch" style="background:${s.color}"></span>${s.label}
                  </span>
                `,
              )}
            </div>
          `
        : nothing}

      <svg
        height=${HEIGHT}
        role="img"
        aria-label="${this.label}. ${n} buckets, peak ${this.format(max)}."
        @pointerleave=${() => (this.hover = null)}
      >
        <g class="grid">
          ${ticks.map(
            (t) => svg`<line x1=${PAD.left} x2=${PAD.left + innerW} y1=${y(t)} y2=${y(t)} />`,
          )}
        </g>
        <g class="axis">
          ${ticks.map(
            (t) => svg`
              <text class="tick" x=${PAD.left - 8} y=${y(t) + 4} text-anchor="end">
                ${this.format(t)}
              </text>`,
          )}
        </g>

        ${this.buckets.map((b, i) => this.column(b, i, slot, barW, y))}

        ${this.buckets.map((b, i) =>
          i % every === 0
            ? svg`
              <text class="tick" x=${PAD.left + i * slot + barW / 2} y=${HEIGHT - 6} text-anchor="middle">
                ${b.label}
              </text>`
            : nothing,
        )}

        ${this.hover != null
          ? svg`<line class="crosshair"
                  x1=${PAD.left + this.hover * slot + barW / 2}
                  x2=${PAD.left + this.hover * slot + barW / 2}
                  y1=${PAD.top} y2=${PAD.top + innerH} />`
          : nothing}

        <!-- Hit targets span the full column height so the pointer doesn't have
             to find the mark itself. -->
        ${this.buckets.map(
          (_, i) => svg`
            <rect class="hit"
              x=${PAD.left + i * slot} y=${PAD.top}
              width=${slot} height=${innerH}
              @pointerenter=${() => (this.hover = i)} />`,
        )}
      </svg>

      ${this.renderTip(slot, barW, innerH)}
    `;
  }

  private column(
    b: Bucket,
    i: number,
    slot: number,
    barW: number,
    y: (v: number) => number,
  ): TemplateResult[] {
    const x = PAD.left + i * slot;
    const out: TemplateResult[] = [];
    let acc = 0;
    // Which series is visually on top decides who gets the rounded end.
    const lastNonZero = b.values.reduce((last, v, idx) => (v > 0 ? idx : last), -1);

    b.values.forEach((v, s) => {
      if (!v) return;
      const yTop = y(acc + v);
      const yBottom = y(acc);
      acc += v;
      // The 2px surface gap between stacked segments; skip it when the segment
      // is too short to survive being trimmed.
      const raw = yBottom - yTop;
      const h = raw > SEG_GAP * 2 ? raw - SEG_GAP : raw;
      const color = this.series[s]?.color ?? "var(--tl-series-1)";
      out.push(
        s === lastNonZero
          ? svg`<path d=${topRounded(x, yTop, barW, h, 4)} fill=${color} />`
          : svg`<rect x=${x} y=${yTop} width=${barW} height=${Math.max(h, 0.5)} fill=${color} />`,
      );
    });
    return out;
  }

  private renderTip(slot: number, barW: number, innerH: number) {
    const i = this.hover;
    if (i == null) return nothing;
    const b = this.buckets[i];
    if (!b) return nothing;
    const total = b.values.reduce((a, v) => a + (v || 0), 0);
    const x = PAD.left + i * slot + barW / 2;

    return html`
      <div
        class="tip"
        style="left:${Math.min(Math.max(x, 90), this.width - 90)}px; top:${PAD.top + innerH - 8}px"
      >
        <h4>${b.label}</h4>
        <dl>
          ${this.series.map((s, si) =>
            b.values[si]
              ? html`
                  <dt>
                    <span class="swatch" style="background:${s.color}"></span>
                    <span>${s.label}</span>
                    <span class="v">${this.format(b.values[si] ?? 0)}</span>
                  </dt>
                `
              : nothing,
          )}
        </dl>
        ${this.series.length > 1
          ? html`<div class="total"><span>Total</span><span>${this.format(total)}</span></div>`
          : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-timeseries": TlTimeseries;
  }
}
