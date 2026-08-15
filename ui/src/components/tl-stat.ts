/**
 * A single headline number.
 *
 * The form heuristic says a lone magnitude with no comparison is a stat tile,
 * not a chart — five of the overview's numbers are exactly that. `caveat` marks
 * a figure whose meaning is narrower than its label suggests, which in this
 * store is the normal case rather than the exception: dollars only exist for
 * the window the OTel sink was running.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/tooltip/tooltip.js";

@customElement("tl-stat")
export class TlStat extends LitElement {
  static override styles = css`
    :host {
      display: block;
      background: var(--jh-color-container-primary-enabled);
      border-radius: var(--tl-radius);
      padding: var(--jh-size-400);
      box-shadow: var(--jh-shadow-100);
      min-width: 0;
    }

    .label {
      display: flex;
      align-items: center;
      gap: var(--jh-size-150);
      font-size: var(--jh-font-size-300);
      line-height: var(--jh-font-line-height-500);
      color: var(--jh-color-content-secondary-enabled);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .value {
      margin-top: var(--jh-size-150);
      /* Deliberately below the display scale: this sits in a row of six, and a
       * true display size would make the row shout over the charts below it. */
      font-size: var(--jh-font-size-900);
      line-height: var(--jh-font-line-height-1100);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--jh-color-content-primary-enabled);
      overflow-wrap: anywhere;
    }

    .sub {
      margin-top: var(--jh-size-100);
      font-size: var(--jh-font-size-300);
      line-height: var(--jh-font-line-height-500);
      color: var(--jh-color-content-secondary-enabled);
    }

    :host([tone="negative"]) .value {
      color: var(--jh-color-content-negative-enabled);
    }

    :host([tone="positive"]) .value {
      color: var(--jh-color-content-positive-enabled);
    }

    .caveat {
      cursor: help;
      color: var(--jh-color-content-secondary-enabled);
      font-size: var(--jh-font-size-300);
    }
  `;

  @property({ type: String }) label = "";
  @property({ type: String }) value = "";
  @property({ type: String }) sub = "";
  /** Reflected so the host-selector tone rules apply. */
  @property({ type: String, reflect: true }) tone: "neutral" | "positive" | "negative" = "neutral";
  @property({ type: String }) caveat = "";

  override render() {
    return html`
      <div class="label">
        <span>${this.label}</span>
        ${this.caveat
          ? html`
              <jh-tooltip label=${this.caveat} position="top">
                <span class="caveat" aria-label=${this.caveat}>&#9432;</span>
              </jh-tooltip>
            `
          : nothing}
      </div>
      <div class="value">${this.value}</div>
      ${this.sub ? html`<div class="sub">${this.sub}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-stat": TlStat;
  }
}
