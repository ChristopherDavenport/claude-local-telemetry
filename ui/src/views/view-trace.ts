/**
 * One trace, as an observability tree.
 *
 * Spans come from the enhanced-telemetry beta exporter, which is off unless
 * `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` — so a store built from backfilled
 * transcripts has none, and this page falls back to the session's event
 * timeline rather than reporting emptiness. The server says which case you are
 * in; this renders that verdict instead of inferring it.
 */

import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";
import "@jack-henry/jh-ui/components/switch/switch.js";

import { TlView } from "../view-base.js";
import { api, type TraceResult } from "../api.js";
import { panel, layout } from "../shared.js";
import * as f from "../format.js";

import "../components/tl-state.js";
import "../components/tl-trace-tree.js";

@customElement("view-trace")
export class ViewTrace extends TlView<TraceResult> {
  static override styles = [
    panel,
    layout,
    css`
      :host {
        display: block;
      }

      .head {
        display: flex;
        align-items: flex-start;
        gap: var(--jh-size-400);
        flex-wrap: wrap;
        margin-bottom: var(--tl-gap);
      }

      .back {
        display: inline-block;
        margin-bottom: var(--jh-size-200);
        font-size: var(--jh-font-size-300);
        color: var(--jh-color-content-brand-enabled);
      }

      h1 {
        margin: 0;
        font-size: var(--jh-font-size-600);
        line-height: var(--jh-font-line-height-800);
        font-weight: 500;
        font-family: var(--jh-font-family-mono);
        overflow-wrap: anywhere;
      }

      jh-card {
        display: block;
      }

      jh-notification {
        display: block;
        margin-bottom: var(--tl-gap);
      }

      .meta {
        margin-top: var(--jh-size-150);
        font-size: var(--jh-font-size-350);
        color: var(--jh-color-content-secondary-enabled);
      }
    `,
  ];

  /** Either identifies the trace; `traceId` wins when both are set. */
  @property({ type: String }) traceId = "";
  @property({ type: String }) sessionId = "";

  @state() private showEvents = true;

  protected override fetchData(signal: AbortSignal): Promise<TraceResult> {
    return api.trace(
      {
        traceId: this.traceId || undefined,
        sessionId: this.traceId ? undefined : this.sessionId || undefined,
        events: this.showEvents ? undefined : false,
      },
      signal,
    );
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (
      (changed.has("traceId") && changed.get("traceId") !== undefined) ||
      (changed.has("sessionId") && changed.get("sessionId") !== undefined)
    ) {
      void this.reload();
    }
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <div>
          <a class="back" href="/traces">&larr; All traces</a>
          <h1>${this.traceId || this.sessionId}</h1>
          ${d ? this.renderMeta(d) : nothing}
        </div>
        <span class="spacer"></span>
        <jh-switch
          label="Show events"
          ?checked=${this.showEvents}
          @jh-change=${(e: Event) => {
            this.showEvents = (e.target as HTMLInputElement & { checked: boolean }).checked;
            void this.reload();
          }}
        ></jh-switch>
      </div>

      <jh-card padding="medium">
        <tl-state .loading=${this.loading && !d} .error=${this.error}>
          ${d ? this.renderTrace(d) : nothing}
        </tl-state>
      </jh-card>
    `;
  }

  private renderMeta(t: TraceResult) {
    return html`
      <p class="meta">
        ${t.spanCount} span${t.spanCount === 1 ? "" : "s"} ·
        ${t.eventCount} event${t.eventCount === 1 ? "" : "s"}${t.truncatedEvents
          ? html` <em>(capped)</em>`
          : nothing}
        ${t.sessionId
          ? html` ·
              <a href="/sessions/${t.sessionId}"
                >session <span class="mono">${f.shortId(t.sessionId, 12)}</span></a
              >`
          : nothing}
      </p>
    `;
  }

  private renderTrace(t: TraceResult) {
    if (!t.tree.length) {
      return html`
        <tl-state empty emptyText="Nothing to show" .emptyHint=${t.note ?? null}></tl-state>
      `;
    }
    return html`
      ${t.note
        ? html`
            <jh-notification appearance="neutral" type="alert" hide-dismiss-button>
              ${t.note}
            </jh-notification>
          `
        : nothing}
      <tl-trace-tree .tree=${t.tree}></tl-trace-tree>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-trace": ViewTrace;
  }
}
