/**
 * Agents, teams and workflows — the work that was delegated.
 *
 * These are three groupings of one thing. A subagent writes its own transcript;
 * a team is a set of named agents spawned together; a workflow run is a set
 * spawned by a script. So the page shows the two groupings first and the
 * individual agents underneath, rather than pretending they are separate
 * subjects.
 *
 * Every token figure is **measured** from the agent's own transcript, not the
 * total its caller reported. The distinction is not pedantic: a backgrounded
 * agent acknowledges immediately and never reports, so the reported figure is
 * null for most of them while the measured one is always there.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, type WorkflowList, type WorkflowRow, type AgentList, type AgentRow, type TeamRow } from "../api.js";
import { panel, layout } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-range.js";

interface Data {
  workflows: WorkflowList;
  teams: { rows: TeamRow[] };
  agents: AgentList;
}

@customElement("view-agents")
export class ViewAgents extends TlView<Data> {
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

      .stats {
        display: grid;
        gap: var(--tl-gap);
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
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

  @state() private days: number | null = null;

  protected override async fetchData(signal: AbortSignal): Promise<Data> {
    const since = sinceFor(this.days);
    const [workflows, teams, agents] = await Promise.all([
      api.workflows({ since, limit: 50 }, signal),
      api.teams({ since, limit: 25 }, signal),
      api.agents({ since, limit: 25 }, signal),
    ]);
    return { workflows, teams, agents };
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <h1>Agents</h1>
        <span class="spacer"></span>
        <tl-range
          .days=${this.days}
          @range-change=${(e: CustomEvent<{ days: number | null }>) => {
            this.days = e.detail.days;
            void this.reload();
          }}
        ></tl-range>
      </div>

      <tl-state
        .loading=${this.loading && !d}
        .error=${this.error}
        .empty=${!!d && !d.agents.rows.length && !d.workflows.rows.length}
        emptyText="No delegated work in this range"
        .emptyHint=${html`Subagent transcripts are read from
          <code>&lt;project&gt;/&lt;session&gt;/subagents/</code>. If this is empty after using
          agents, re-run <code>backfill</code> — a store built before schema v2 has them
          imported but untagged.`}
      >
        ${d ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: Data) {
    const totalIn = d.agents.rows.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
    return html`
      <div class="stats">
        <tl-stat label="Workflow runs" value=${f.count(d.workflows.rows.length)}></tl-stat>
        <tl-stat label="Teams" value=${f.count(d.teams.rows.length)}></tl-stat>
        <tl-stat
          label="Agents shown"
          value=${f.count(d.agents.rows.length)}
          sub=${d.agents.spawnsWithoutTurns
            ? `${d.agents.spawnsWithoutTurns} spawns produced no turns`
            : ""}
          caveat="Spawns with no turns are backgrounded agents whose transcript is not on disk — still running, or discarded."
        ></tl-stat>
        <tl-stat
          label="Tokens in top agents"
          value=${f.short(totalIn)}
          sub="input plus cache, measured"
        ></tl-stat>
      </div>

      ${d.workflows.rows.length
        ? html`
            <jh-card
              header-title="Workflow runs"
              header-subtitle="Agents and cost measured from the transcripts each run wrote"
              padding="medium"
              show-header-divider
            >
              <tl-table
                .columns=${this.workflowColumns()}
                .rows=${d.workflows.rows}
                clickable
                @row-click=${(e: CustomEvent<WorkflowRow>) =>
                  navigate(this, `/workflow/${e.detail.run_id}`)}
              ></tl-table>
            </jh-card>
          `
        : html`
            <jh-notification appearance="neutral" type="alert" hide-dismiss-button>
              ${d.workflows.note ?? "No workflow runs in this range."}
            </jh-notification>
          `}

      ${d.teams.rows.length
        ? html`
            <jh-card
              header-title="Teams"
              header-subtitle="Named agents spawned together"
              padding="medium"
              show-header-divider
            >
              <tl-table
                .columns=${this.teamColumns()}
                .rows=${d.teams.rows}
                clickable
                @row-click=${(e: CustomEvent<TeamRow>) =>
                  navigate(this, `/agents?team=${encodeURIComponent(e.detail.team_name)}`)}
              ></tl-table>
            </jh-card>
          `
        : nothing}

      <jh-card
        header-title="Agents by measured tokens"
        padding="medium"
        show-header-divider
      >
        <tl-bars
          .data=${d.agents.rows.slice(0, 15).map((r) => ({
            label: r.label ?? r.agent_type ?? r.agent_id,
            value: r.input_tokens,
            detail: `${f.count(r.requests)} requests${r.team_name ? ` · team ${r.team_name}` : ""}`,
            id: r.agent_id,
          }))}
          .format=${(v: number | null) => f.short(v)}
        ></tl-bars>
        <div style="margin-top: var(--tl-gap)">
          <tl-table .columns=${this.agentColumns()} .rows=${d.agents.rows}></tl-table>
        </div>
      </jh-card>
    `;
  }

  private workflowColumns(): Column[] {
    return [
      {
        key: "started_at",
        label: "Started",
        render: (r: WorkflowRow) =>
          html`<span title=${r.started_at}>${f.dateTime(r.started_at)}</span>`,
      },
      {
        key: "name",
        label: "Workflow",
        render: (r: WorkflowRow) =>
          r.name
            ? html`<span class="mono">${r.name}</span>`
            : html`<span class="muted">inline script</span>`,
      },
      { key: "agents", label: "Agents", align: "right", render: (r: WorkflowRow) => f.count(r.agents) },
      { key: "requests", label: "Requests", align: "right", render: (r: WorkflowRow) => f.count(r.requests) },
      {
        key: "input_tokens",
        label: "In + cache",
        align: "right",
        render: (r: WorkflowRow) => f.short(r.input_tokens),
      },
      {
        key: "output_tokens",
        label: "Out",
        align: "right",
        render: (r: WorkflowRow) => f.short(r.output_tokens),
      },
      { key: "cost_usd", label: "Cost", align: "right", render: (r: WorkflowRow) => f.usd(r.cost_usd) },
    ];
  }

  private teamColumns(): Column[] {
    return [
      { key: "team_name", label: "Team", render: (r: TeamRow) => html`<span class="mono">${r.team_name}</span>` },
      { key: "members", label: "Members", align: "right", render: (r: TeamRow) => f.count(r.members) },
      { key: "agent_types", label: "Types", align: "right", render: (r: TeamRow) => f.count(r.agent_types) },
      { key: "requests", label: "Requests", align: "right", render: (r: TeamRow) => f.count(r.requests) },
      {
        key: "input_tokens",
        label: "In + cache",
        align: "right",
        render: (r: TeamRow) => f.short(r.input_tokens),
      },
      { key: "cost_usd", label: "Cost", align: "right", render: (r: TeamRow) => f.usd(r.cost_usd) },
    ];
  }

  private agentColumns(): Column[] {
    return [
      {
        key: "label",
        label: "Agent",
        render: (r: AgentRow) =>
          html`<span class="mono" title=${r.agent_id}>${r.label ?? f.shortId(r.agent_id, 14)}</span>`,
      },
      {
        key: "agent_type",
        label: "Type",
        render: (r: AgentRow) => r.agent_type ?? html`<span class="muted">—</span>`,
      },
      {
        key: "team_name",
        label: "Team",
        render: (r: AgentRow) => r.team_name ?? html`<span class="muted">—</span>`,
      },
      { key: "requests", label: "Requests", align: "right", render: (r: AgentRow) => f.count(r.requests) },
      {
        key: "input_tokens",
        label: "In + cache",
        align: "right",
        render: (r: AgentRow) => f.short(r.input_tokens),
      },
      {
        key: "reported_tokens",
        label: "Reported",
        align: "right",
        render: (r: AgentRow) =>
          r.reported_tokens == null
            ? html`<span class="muted" title="Backgrounded agents never report totals">—</span>`
            : f.short(r.reported_tokens),
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-agents": ViewAgents;
  }
}
