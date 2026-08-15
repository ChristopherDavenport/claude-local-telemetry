/**
 * Time range control.
 *
 * One row, above the charts, shared by every view that takes a `since`. The
 * selected preset is carried in the URL by the views that own one, so a link to
 * "the last 24 hours of tool calls" survives a reload.
 *
 * "All" sends no `since` at all rather than a very old date — the store starts
 * wherever the first backfilled transcript starts, and inventing a floor here
 * would silently clip anyone with a longer history.
 */

import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/button/button.js";
import { daysAgo } from "../format.js";

export interface RangeChange {
  days: number | null;
  since: string | undefined;
}

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: null },
];

@customElement("tl-range")
export class TlRange extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--jh-size-150);
    }

    .label {
      font-size: var(--jh-font-size-300);
      font-weight: 500;
      color: var(--jh-color-content-secondary-enabled);
      margin-inline-end: var(--jh-size-100);
    }
  `;

  /** `null` means all time. */
  @property({ type: Number }) days: number | null = 30;

  override render() {
    return html`
      <span class="label" id="range-label">Range</span>
      <span role="group" aria-labelledby="range-label">
        ${PRESETS.map(
          (p) => html`
            <jh-button
              size="small"
              appearance=${this.days === p.days ? "primary" : "tertiary"}
              label=${p.label}
              @click=${() => this.pick(p.days)}
            ></jh-button>
          `,
        )}
      </span>
    `;
  }

  private pick(days: number | null) {
    if (days === this.days) return;
    this.days = days;
    this.dispatchEvent(
      new CustomEvent<RangeChange>("range-change", {
        detail: { days, since: days == null ? undefined : daysAgo(days) },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

/** The `since` for a preset, so callers can compute one without an event. */
export function sinceFor(days: number | null): string | undefined {
  return days == null ? undefined : daysAgo(days);
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-range": TlRange;
  }
}
