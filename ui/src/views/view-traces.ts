/**
 * Traces index.
 *
 * Before this existed a trace was only reachable by pasting an id or arriving
 * from a session, which made the whole trace surface undiscoverable.
 *
 * The empty state does real work here. Spans require the beta exporter, so for
 * most stores this list is legitimately empty — and an empty page would read as
 * "traces are broken" rather than "traces are off". It therefore explains the
 * flag *and* offers the thing that does exist: every session has an event
 * timeline rendered as the same tree, so the recent-sessions list below is a
 * working substitute rather than a consolation.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, type TraceList, type TraceListRow, type SessionRow } from "../api.js";
import { panel, layout } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-table.js";
import "../components/tl-range.js";

interface Data {
  traces: TraceList;
  /** Only fetched to power the fallback; cheap, and always relevant. */
  sessions: { rows: SessionRow[] };
}

@customElement("view-traces")
export class ViewTraces extends TlView<Data> {
  static override styles = [
    panel,
    layout,
    css`
      :host {
        display: block;
      }

      .head {
        display: flex;
        align-items: center;
        gap: var(--jh-size-400);
        flex-wrap: wrap;
        margin-bottom: var(--tl-gap);
      }

      h1 {
        margin: 0;
        font-size: var(--jh-font-size-700);
        line-height: var(--jh-font-line-height-900);
        font-weight: 500;
      }

      jh-card {
        display: block;
      }

      jh-card + jh-card {
        margin-top: var(--tl-gap);
      }

      jh-notification {
        display: block;
        margin-bottom: var(--tl-gap);
      }

      code {
        font-family: var(--jh-font-family-mono);
        font-size: var(--jh-font-size-300);
        background: var(--jh-color-container-secondary-enabled);
        border-radius: var(--jh-border-radius-50);
        padding: 1px 4px;
      }
    `,
  ];

  @state() private days: number | null = 30;

  protected override async fetchData(signal: AbortSignal): Promise<Data> {
    const since = sinceFor(this.days);
    const [traces, sessions] = await Promise.all([
      api.traces({ since, limit: 100 }, signal),
      api.sessions({ since, limit: 15 }, signal),
    ]);
    return { traces, sessions };
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <h1>Traces</h1>
        <span class="spacer"></span>
        <tl-range
          .days=${this.days}
          @range-change=${(e: CustomEvent<{ days: number | null }>) => {
            this.days = e.detail.days;
            void this.reload();
          }}
        ></tl-range>
      </div>

      <tl-state .loading=${this.loading && !d} .error=${this.error}>
        ${d ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: Data) {
    return d.traces.rows.length ? this.renderTraces(d.traces) : this.renderFallback(d);
  }

  private renderTraces(t: TraceList) {
    const cols: Column[] = [
      {
        key: "started_at",
        label: "Started",
        render: (r: TraceListRow) =>
          html`<span title=${r.started_at}>${f.dateTime(r.started_at)}</span>`,
      },
      {
        key: "root_name",
        label: "Root span",
        render: (r: TraceListRow) =>
          r.root_name
            ? html`<span class="mono">${r.root_name}</span>`
            : html`<span class="muted">no root</span>`,
      },
      {
        key: "span_count",
        label: "Spans",
        align: "right",
        render: (r: TraceListRow) => f.count(r.span_count),
      },
      {
        key: "duration_ms",
        label: "Duration",
        align: "right",
        render: (r: TraceListRow) => f.ms(r.duration_ms),
      },
      {
        key: "session_id",
        label: "Session",
        render: (r: TraceListRow) =>
          r.session_id
            ? html`<span class="mono muted" title=${r.session_id}
                >${f.shortId(r.session_id, 12)}</span
              >`
            : html`<span class="muted">—</span>`,
      },
      {
        key: "trace_id",
        label: "Trace",
        sortable: false,
        render: (r: TraceListRow) =>
          html`<span class="mono muted" title=${r.trace_id}>${f.shortId(r.trace_id, 12)}</span>`,
      },
    ];

    return html`
      <jh-card padding="medium">
        <tl-table
          caption=${`${t.rows.length} trace${t.rows.length === 1 ? "" : "s"} — click to open the tree`}
          .columns=${cols}
          .rows=${t.rows}
          clickable
          @row-click=${(e: CustomEvent<TraceListRow>) =>
            navigate(this, `/trace/${e.detail.trace_id}`)}
        ></tl-table>
      </jh-card>
    `;
  }

  private renderFallback(d: Data) {
    return html`
      <jh-notification appearance="neutral" type="alert" hide-dismiss-button>
        ${d.traces.note ?? "No traces in this range."}
      </jh-notification>

      <jh-card
        header-title="Session event timelines"
        header-subtitle="The same tree, built from events — available without the beta exporter"
        padding="medium"
        show-header-divider
      >
        <p class="panel-note">
          Turn spans on with
          <code>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</code> and the sink running; until then
          each session's events still form a timeline.
        </p>
        ${d.sessions.rows.length
          ? html`
              <tl-table
                .columns=${[
                  {
                    key: "started_at",
                    label: "Started",
                    render: (r: SessionRow) => f.dateTime(r.started_at),
                  },
                  {
                    key: "cwd",
                    label: "Directory",
                    render: (r: SessionRow) =>
                      html`<span title=${r.cwd ?? ""}>${f.shortPath(r.cwd)}</span>`,
                  },
                  {
                    key: "requests",
                    label: "Requests",
                    align: "right" as const,
                    render: (r: SessionRow) => f.count(r.requests),
                  },
                  {
                    key: "tool_calls",
                    label: "Tools",
                    align: "right" as const,
                    render: (r: SessionRow) => f.count(r.tool_calls),
                  },
                ] satisfies Column[]}
                .rows=${d.sessions.rows}
                clickable
                @row-click=${(e: CustomEvent<SessionRow>) =>
                  navigate(this, `/sessions/${e.detail.session_id}`)}
              ></tl-table>
            `
          : html`<tl-state empty emptyText="No sessions in this range"></tl-state>`}
      </jh-card>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-traces": ViewTraces;
  }
}
