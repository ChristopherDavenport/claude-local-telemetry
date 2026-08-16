/**
 * One session, drilled into.
 *
 * This used to compose `/api/query` aggregates and interpolate
 * `session_id='…'` into a `where` string, guarded by a regex on the id. Every
 * query it needs now takes a `sessionId` parameter, so the string-building and
 * its guard are gone and the page can show real rows instead of only totals.
 *
 * The agents card is the reason this page is worth opening on a session that
 * delegated: subagent turns are recorded against this same session id, so
 * without the breakdown their cost simply inflates the session's totals with no
 * indication of where it went.
 */

import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import {
  api, type SessionRow, type CostResult, type ToolAudit, type ToolRow,
  type AgentList, type AgentRow, type TraceResult,
} from "../api.js";
import { panel, layout } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-trace-tree.js";

interface Data {
  session: SessionRow | null;
  byModel: CostResult;
  tools: ToolAudit;
  agents: AgentList;
  trace: TraceResult;
}

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

  protected override async fetchData(signal: AbortSignal): Promise<Data> {
    const sessionId = this.sessionId;
    const [list, byModel, tools, agents, trace] = await Promise.all([
      api.sessions({ sessionId, limit: 1 }, signal),
      api.cost({ groupBy: "model", sessionId, limit: 12 }, signal),
      api.tools({ sessionId, limit: 100 }, signal),
      api.agents({ sessionId, limit: 50 }, signal),
      api.trace({ sessionId }, signal),
    ]);
    return { session: list.rows[0] ?? null, byModel, tools, agents, trace };
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
        ${d?.session ? this.renderMeta(d.session) : nothing}
      </div>

      <tl-state
        .loading=${this.loading && !d}
        .error=${this.error}
        .empty=${!!d && !d.session}
        emptyText="No such session"
      >
        ${d && d.session ? this.renderData(d, d.session) : nothing}
      </tl-state>
    `;
  }

  private renderMeta(s: SessionRow) {
    return html`
      <div class="meta">
        ${s.cwd ? html`<span title=${s.cwd}>📁 ${s.cwd}</span>` : nothing}
        ${s.branch ? html`<span>⎇ ${s.branch}</span>` : nothing}
        ${s.started_at ? html`<span>${f.dateTime(s.started_at)}</span>` : nothing}
      </div>
    `;
  }

  private renderData(d: Data, s: SessionRow) {
    const denied = d.tools.rows.filter((r) => r.decision && r.decision !== "allow").length;
    const agentIn = d.agents.rows.reduce((a, r) => a + (r.input_tokens ?? 0), 0);

    return html`
      <div class="stats">
        <tl-stat label="Requests" value=${f.count(s.requests)}></tl-stat>
        <tl-stat
          label="Cost"
          value=${f.usd(s.cost_usd)}
          caveat="Null unless this session was captured by the OTLP sink."
        ></tl-stat>
        <tl-stat label="Tool calls" value=${f.count(s.tool_calls)}></tl-stat>
        <tl-stat
          label="Agents"
          value=${f.count(d.agents.rows.length)}
          sub=${d.agents.rows.length ? `${f.short(agentIn)} tokens delegated` : ""}
          caveat="Subagent turns are recorded against this session, so their cost is already inside the totals above."
        ></tl-stat>
        <tl-stat
          label="Non-allow decisions"
          value=${f.count(denied)}
          tone=${denied > 0 ? "negative" : "neutral"}
        ></tl-stat>
      </div>

      ${d.agents.rows.length
        ? html`
            <jh-card
              header-title="Delegated to agents"
              header-subtitle="Measured from each agent's own transcript"
              padding="medium"
              show-header-divider
            >
              <tl-table
                .columns=${this.agentColumns()}
                .rows=${d.agents.rows}
                clickable
                @row-click=${(e: CustomEvent<AgentRow>) =>
                  e.detail.workflow_run_id
                    ? navigate(this, `/workflow/${e.detail.workflow_run_id}`)
                    : navigate(this, `/tools?agent=${encodeURIComponent(e.detail.agent_id)}`)}
              ></tl-table>
            </jh-card>
          `
        : nothing}

      <div class="grid-2">
        <jh-card header-title="Cost by model" padding="medium" show-header-divider>
          ${d.byModel.rows.length
            ? html`
                <tl-bars
                  .data=${d.byModel.rows.map((r) => ({
                    label: r.grp ?? "—",
                    value: r.cost_usd ?? (r.input_tokens ?? 0) + (r.cache_read ?? 0),
                    detail: `${f.count(r.n)} requests`,
                  }))}
                  .format=${d.byModel.rows.some((r) => r.cost_usd != null)
                    ? (v: number | null) => f.usd(v)
                    : (v: number | null) => f.short(v)}
                ></tl-bars>
                ${d.byModel.rows.some((r) => r.cost_usd != null)
                  ? nothing
                  : html`<p class="panel-note" style="margin: var(--jh-size-300) 0 0">
                      No cost recorded — showing input plus cache tokens.
                    </p>`}
              `
            : html`<tl-state empty emptyText="No requests recorded"></tl-state>`}
        </jh-card>

        <jh-card header-title="Tools used" padding="medium" show-header-divider>
          ${d.tools.summary.length
            ? html`
                <tl-bars
                  .data=${d.tools.summary.map((t) => ({
                    label: t.tool_name ?? "—",
                    value: t.n,
                    detail: t.failures ? `${t.failures} failed` : "no failures",
                  }))}
                  .format=${(v: number | null) => f.count(v)}
                ></tl-bars>
              `
            : html`<tl-state empty emptyText="No tool calls recorded"></tl-state>`}
        </jh-card>
      </div>

      ${d.tools.rows.length
        ? html`
            <jh-card header-title="Tool calls" padding="medium" show-header-divider>
              <tl-table
                caption=${`${d.tools.rows.length} most recent`}
                .columns=${this.toolColumns()}
                .rows=${d.tools.rows}
              ></tl-table>
            </jh-card>
          `
        : nothing}

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

  private agentColumns(): Column[] {
    return [
      {
        key: "label",
        label: "Agent",
        render: (r: AgentRow) =>
          html`<span class="mono" title=${r.agent_id}>${r.label ?? f.shortId(r.agent_id, 16)}</span>`,
      },
      {
        key: "agent_type",
        label: "Type",
        render: (r: AgentRow) => r.agent_type ?? html`<span class="muted">—</span>`,
      },
      {
        key: "workflow_run_id",
        label: "Workflow",
        render: (r: AgentRow) =>
          r.workflow_run_id
            ? html`<span class="mono">${f.shortId(r.workflow_run_id, 14)}</span>`
            : html`<span class="muted">—</span>`,
      },
      { key: "requests", label: "Requests", align: "right", render: (r: AgentRow) => f.count(r.requests) },
      {
        key: "input_tokens",
        label: "In + cache",
        align: "right",
        render: (r: AgentRow) => f.short(r.input_tokens),
      },
      {
        key: "output_tokens",
        label: "Out",
        align: "right",
        render: (r: AgentRow) => f.short(r.output_tokens),
      },
    ];
  }

  private toolColumns(): Column[] {
    return [
      { key: "ts", label: "When", render: (r: ToolRow) => f.dateTime(r.ts) },
      { key: "tool_name", label: "Tool" },
      {
        key: "success",
        label: "Result",
        render: (r: ToolRow) =>
          r.success == null
            ? html`<span class="muted">—</span>`
            : r.success
              ? html`<span class="positive">ok</span>`
              : html`<span class="negative">${r.error_type ?? "failed"}</span>`,
      },
      {
        key: "decision",
        label: "Decision",
        render: (r: ToolRow) => r.decision ?? html`<span class="muted">—</span>`,
      },
      { key: "duration_ms", label: "Duration", align: "right", render: (r: ToolRow) => f.ms(r.duration_ms) },
    ];
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
