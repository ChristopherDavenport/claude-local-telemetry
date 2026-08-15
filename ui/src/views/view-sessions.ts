/**
 * Sessions — the list you scan, rather than a question you ask.
 *
 * This is the half of the product the MCP tools are weakest at. Asking Claude
 * "which session was expensive" costs a round trip and returns prose; a sorted
 * table answers it at a glance and gives you somewhere to click.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";

import { TlView } from "../view-base.js";
import { api, type SessionRow } from "../api.js";
import { panel, layout, toolbar } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-table.js";
import "../components/tl-range.js";

@customElement("view-sessions")
export class ViewSessions extends TlView<{ rows: SessionRow[] }> {
  static override styles = [
    panel,
    layout,
    toolbar,
    css`
      :host {
        display: block;
      }

      h1 {
        margin: 0 0 var(--tl-gap);
        font-size: var(--jh-font-size-700);
        line-height: var(--jh-font-line-height-900);
        font-weight: 500;
      }

      jh-card {
        display: block;
      }
    `,
  ];

  @state() private days: number | null = 30;
  @state() private cwd = "";
  @state() private limit = 100;

  private debounce?: ReturnType<typeof setTimeout>;

  protected override fetchData(signal: AbortSignal): Promise<{ rows: SessionRow[] }> {
    return api.sessions(
      { since: sinceFor(this.days), cwdLike: this.cwd || undefined, limit: this.limit },
      signal,
    );
  }

  override disconnectedCallback() {
    clearTimeout(this.debounce);
    super.disconnectedCallback();
  }

  override render() {
    const rows = this.data?.rows ?? [];
    return html`
      <h1>Sessions</h1>

      <div class="toolbar">
        <span class="field">
          <label for="cwd">Directory contains</label>
          <input
            id="cwd"
            type="text"
            .value=${this.cwd}
            placeholder="e.g. claude-local-telemetry"
            @input=${(e: Event) => {
              this.cwd = (e.target as HTMLInputElement).value;
              // Typing a path fires an input per keystroke; one request per
              // pause is plenty and the in-flight one is aborted anyway.
              clearTimeout(this.debounce);
              this.debounce = setTimeout(() => void this.reload(), 250);
            }}
          />
        </span>
        <span class="field">
          <label for="limit">Rows</label>
          <select
            id="limit"
            @change=${(e: Event) => {
              this.limit = Number((e.target as HTMLSelectElement).value);
              void this.reload();
            }}
          >
            ${[25, 100, 250, 500].map(
              (n) => html`<option value=${n} ?selected=${n === this.limit}>${n}</option>`,
            )}
          </select>
        </span>
        <span class="spacer"></span>
        <tl-range
          .days=${this.days}
          @range-change=${(e: CustomEvent<{ days: number | null }>) => {
            this.days = e.detail.days;
            void this.reload();
          }}
        ></tl-range>
      </div>

      <jh-card padding="medium">
        <tl-state
          .loading=${this.loading && !this.data}
          .error=${this.error}
          .empty=${!!this.data && rows.length === 0}
          emptyText="No sessions match"
          .emptyHint=${html`Widen the range, or clear the directory filter.`}
        >
          ${rows.length
            ? html`
                <tl-table
                  caption=${`${rows.length} session${rows.length === 1 ? "" : "s"} — click to drill in`}
                  .columns=${this.columns()}
                  .rows=${rows}
                  clickable
                  @row-click=${(e: CustomEvent<SessionRow>) =>
                    navigate(this, `/sessions/${e.detail.session_id}`)}
                ></tl-table>
              `
            : nothing}
        </tl-state>
      </jh-card>
    `;
  }

  private columns(): Column[] {
    return [
      {
        key: "started_at",
        label: "Started",
        render: (r: SessionRow) =>
          html`<span title=${r.started_at ?? ""}>${f.dateTime(r.started_at)}</span>`,
      },
      {
        key: "cwd",
        label: "Directory",
        render: (r: SessionRow) => html`<span title=${r.cwd ?? ""}>${f.shortPath(r.cwd)}</span>`,
      },
      {
        key: "branch",
        label: "Branch",
        render: (r: SessionRow) =>
          r.branch ? html`<span class="mono">${r.branch}</span>` : html`<span class="muted">—</span>`,
      },
      { key: "requests", label: "Requests", align: "right", render: (r: SessionRow) => f.count(r.requests) },
      { key: "tool_calls", label: "Tools", align: "right", render: (r: SessionRow) => f.count(r.tool_calls) },
      {
        key: "input_tokens",
        label: "Input",
        align: "right",
        render: (r: SessionRow) => f.short(r.input_tokens),
      },
      {
        key: "output_tokens",
        label: "Output",
        align: "right",
        render: (r: SessionRow) => f.short(r.output_tokens),
      },
      { key: "cost_usd", label: "Cost", align: "right", render: (r: SessionRow) => f.usd(r.cost_usd) },
      {
        key: "session_id",
        label: "ID",
        sortable: false,
        render: (r: SessionRow) =>
          html`<span class="mono muted" title=${r.session_id}>${f.shortId(r.session_id)}</span>`,
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-sessions": ViewSessions;
  }
}
