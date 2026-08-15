/**
 * One session, drilled into.
 *
 * There is no per-session endpoint on the API, so this composes the generic
 * `/api/query` aggregate with `/api/trace`. That is a deliberate limit rather
 * than an oversight worth routing around: `queries.ts` is the shared surface
 * for the MCP server and this dashboard both, and quietly adding a
 * dashboard-only query would start exactly the drift that module exists to
 * prevent. If a first-class session endpoint is wanted, it belongs there — and
 * then Claude gets it too.
 *
 * The consequence is visible: this page shows composition and totals, not a
 * per-request log, because `/api/query` returns aggregates.
 */

import { html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, type QueryResult, type TraceResult } from "../api.js";
import { panel, layout } from "../shared.js";
import * as f from "../format.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-bars.js";
import "../components/tl-trace-tree.js";

interface Data {
  cwd: QueryResult;
  branch: QueryResult;
  requests: QueryResult;
  cost: QueryResult;
  byModel: QueryResult;
  tools: QueryResult;
  outcomes: QueryResult;
  trace: TraceResult;
}

/**
 * `where` is interpolated into SQL by the server, which rejects statement
 * separators and DDL but does not parameterise. Session ids are UUIDs, so
 * anything outside this alphabet is not an id we generated — refuse rather
 * than send it.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const first = (r: QueryResult | undefined): number | null => r?.rows[0]?.value ?? null;

@customElement("view-session")
export class ViewSession extends TlView<Data> {
  static override styles = [
    panel,
    layout,
    css`
      :host {
        display: block;
      }

      h1 {
        margin: 0;
        font-size: var(--jh-font-size-600);
        line-height: var(--jh-font-line-height-800);
        font-weight: 500;
        font-family: var(--jh-font-family-mono);
        overflow-wrap: anywhere;
      }

      .head {
        margin-bottom: var(--tl-gap);
      }

      .back {
        display: inline-block;
        margin-bottom: var(--jh-size-200);
        font-size: var(--jh-font-size-300);
        color: var(--jh-color-content-brand-enabled);
      }

      .meta {
        margin-top: var(--jh-size-200);
        font-size: var(--jh-font-size-350);
        color: var(--jh-color-content-secondary-enabled);
        display: flex;
        flex-wrap: wrap;
        gap: var(--jh-size-400);
      }

      .stats {
        display: grid;
        gap: var(--tl-gap);
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        margin-bottom: var(--tl-gap);
      }

      jh-card {
        display: block;
      }

      jh-card + jh-card,
      .grid-2 + jh-card {
        margin-top: var(--tl-gap);
      }
    `,
  ];

  @property({ type: String }) sessionId = "";

  @state() private rejected = false;

  protected override async fetchData(signal: AbortSignal): Promise<Data> {
    const id = this.sessionId;
    if (!SAFE_ID.test(id)) {
      this.rejected = true;
      throw new Error(`"${id}" is not a valid session id.`);
    }
    this.rejected = false;
    const where = `session_id='${id}'`;

    const [cwd, branch, requests, cost, byModel, tools, outcomes, trace] = await Promise.all([
      api.query({ table: "sessions", calculate: "count", breakdown: "cwd", where }, signal),
      api.query({ table: "sessions", calculate: "count", breakdown: "git_branch", where }, signal),
      api.query({ table: "api_requests", calculate: "count", where }, signal),
      api.query({ table: "api_requests", calculate: "sum_cost", where }, signal),
      api.query({ table: "api_requests", calculate: "sum_cost", breakdown: "model", where }, signal),
      api.query({ table: "tool_calls", calculate: "count", breakdown: "tool_name", where, limit: 25 }, signal),
      api.query({ table: "tool_calls", calculate: "count", breakdown: "decision", where }, signal),
      api.trace({ sessionId: id }, signal),
    ]);
    return { cwd, branch, requests, cost, byModel, tools, outcomes, trace };
  }

  override willUpdate(changed: Map<string, unknown>) {
    // The router reuses this element across /sessions/:id navigations, so a new
    // id has to trigger a refetch — connectedCallback fires only once.
    if (changed.has("sessionId") && changed.get("sessionId") !== undefined) {
      void this.reload();
    }
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <a class="back" href="/sessions/">&larr; All sessions</a>
        <h1>${this.sessionId}</h1>
        ${d ? this.renderMeta(d) : nothing}
      </div>

      <tl-state .loading=${this.loading && !d} .error=${this.error}>
        ${d && !this.rejected ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderMeta(d: Data) {
    const cwd = d.cwd.rows[0]?.grp ?? null;
    const branch = d.branch.rows[0]?.grp ?? null;
    if (!cwd && !branch) return nothing;
    return html`
      <div class="meta">
        ${cwd ? html`<span title=${cwd}>📁 ${cwd}</span>` : nothing}
        ${branch ? html`<span>⎇ ${branch}</span>` : nothing}
      </div>
    `;
  }

  private renderData(d: Data) {
    const toolTotal = d.tools.rows.reduce((a, r) => a + (r.value ?? 0), 0);
    const denied = d.outcomes.rows
      .filter((r) => r.grp && r.grp !== "allow")
      .reduce((a, r) => a + (r.value ?? 0), 0);

    return html`
      <div class="stats">
        <tl-stat label="Requests" value=${f.count(first(d.requests))}></tl-stat>
        <tl-stat
          label="Cost"
          value=${f.usd(first(d.cost))}
          caveat="Null unless this session was captured by the OTLP sink."
        ></tl-stat>
        <tl-stat label="Tool calls" value=${f.count(toolTotal)}></tl-stat>
        <tl-stat
          label="Non-allow decisions"
          value=${f.count(denied)}
          tone=${denied > 0 ? "negative" : "neutral"}
        ></tl-stat>
      </div>

      <div class="grid-2">
        <jh-card header-title="Cost by model" padding="medium" show-header-divider>
          ${d.byModel.rows.length
            ? html`
                <tl-bars
                  .data=${d.byModel.rows.map((r) => ({ label: r.grp ?? "—", value: r.value }))}
                  .format=${(v: number | null) => f.usd(v)}
                ></tl-bars>
              `
            : html`<tl-state empty emptyText="No requests recorded"></tl-state>`}
        </jh-card>

        <jh-card header-title="Tools used" padding="medium" show-header-divider>
          ${d.tools.rows.length
            ? html`
                <tl-bars
                  .data=${d.tools.rows.map((r) => ({ label: r.grp ?? "—", value: r.value }))}
                  .format=${(v: number | null) => f.count(v)}
                ></tl-bars>
              `
            : html`<tl-state empty emptyText="No tool calls recorded"></tl-state>`}
        </jh-card>
      </div>

      <jh-card
        header-title="Observability tree"
        header-subtitle="Nested spans with this session's events woven in by time"
        padding="medium"
        show-header-divider
      >
        ${this.renderTrace(d.trace)}
      </jh-card>
    `;
  }

  private renderTrace(t: TraceResult) {
    if (!t.tree.length) {
      return html`
        <tl-state
          empty
          emptyText="Nothing recorded for this session"
          .emptyHint=${t.note ?? null}
        ></tl-state>
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
      <p class="panel-note">
        ${t.spanCount} span${t.spanCount === 1 ? "" : "s"} ·
        ${t.eventCount} event${t.eventCount === 1 ? "" : "s"}${t.truncatedEvents
          ? html` <em>(capped)</em>`
          : nothing}
        ${t.traceId
          ? html` ·
              <a href="/trace/${t.traceId}"
                >trace <span class="mono">${f.shortId(t.traceId, 16)}</span></a
              >`
          : nothing}
      </p>
      <tl-trace-tree .tree=${t.tree}></tl-trace-tree>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-session": ViewSession;
  }
}
