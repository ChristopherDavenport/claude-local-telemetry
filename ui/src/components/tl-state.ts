/**
 * Loading / error / empty wrapper.
 *
 * Every view fetches, so every view needs the same three non-happy states. The
 * distinction that matters here is **empty vs. absent**: an empty table because
 * the filter excluded everything is a different fact from an empty table
 * because the sink has never run, and the second one needs to say what to do
 * about it. Callers pass `emptyHint` for that.
 */

import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/progress/progress.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

@customElement("tl-state")
export class TlState extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }

    .center {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--jh-size-300);
      padding: var(--jh-size-700) var(--jh-size-400);
      color: var(--jh-color-content-secondary-enabled);
      font-size: var(--jh-font-size-350);
    }

    .empty {
      flex-direction: column;
      text-align: center;
    }

    .empty-hint {
      font-size: var(--jh-font-size-300);
      max-width: 46ch;
    }

    code {
      font-family: var(--jh-font-family-mono);
      font-size: var(--jh-font-size-300);
      background: var(--jh-color-container-secondary-enabled);
      border-radius: var(--jh-border-radius-50);
      padding: 1px 4px;
    }
  `;

  @property({ type: Boolean }) loading = false;
  @property({ attribute: false }) error: Error | null = null;
  @property({ type: Boolean }) empty = false;
  @property({ type: String }) emptyText = "Nothing to show";
  @property({ attribute: false }) emptyHint: TemplateResult | string | null = null;

  override render() {
    if (this.error) {
      return html`
        <jh-notification appearance="negative" type="alert" hide-dismiss-button>
          ${this.error.message}
        </jh-notification>
      `;
    }
    if (this.loading) {
      return html`
        <div class="center">
          <jh-progress indeterminate size="small" accessible-label="Loading"></jh-progress>
          <span>Loading…</span>
        </div>
      `;
    }
    if (this.empty) {
      return html`
        <div class="center empty">
          <span>${this.emptyText}</span>
          ${this.emptyHint ? html`<span class="empty-hint">${this.emptyHint}</span>` : nothing}
        </div>
      `;
    }
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-state": TlState;
  }
}
