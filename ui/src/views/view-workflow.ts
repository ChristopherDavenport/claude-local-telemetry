/**
 * One workflow run, broken down by the agents that did the work.
 *
 * The run row is what the Workflow tool reported when it returned; the agent
 * rows are measured from the transcripts each agent wrote. A run whose script
 * fanned out widely shows that here as a long tail of small agents, which is
 * the shape worth seeing — a workflow's cost is almost never in the
 * orchestration.
 */

import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";

import { TlView } from "../view-base.js";
import { api, type WorkflowDetail } from "../api.js";
import { panel, layout } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";

type AgentDetail = WorkflowDetail["agents"][number];

@customElement("view-workflow")
export class ViewWorkflow extends TlView<WorkflowDetail> {
  static override styles = [
    panel,
    layout,
    css`
      :host {
        display: block;
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
      }

      .meta {
        margin: var(--jh-size-200) 0 var(--tl-gap);
        font-size: var(--jh-font-size-300);
        color: var(--jh-color-content-secondary-enabled);
        overflow-wrap: anywhere;
      }

      .stats {
        display: grid;
        gap: var(--tl-gap);
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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

  @property({ type: String }) runId = "";

  protected override fetchData(signal: AbortSignal): Promise<WorkflowDetail> {
    return api.workflow({ runId: this.runId }, signal);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("runId") && changed.get("runId") !== undefined) void this.reload();
  }

  override render() {
    const d = this.data;
    const run = d?.run as Record<string, unknown> | null | undefined;
    return html`
      <a class="back" href="/agents">&larr; All agents</a>
      <h1>${(run?.["name"] as string) ?? this.runId}</h1>
      <p class="meta">
        <span class="mono">${this.runId}</span>
        ${run?.["session_id"]
          ? html` · <a href="/sessions/${run["session_id"]}">parent session</a>`
          : nothing}
        ${run?.["script_path"] ? html`<br /><span class="mono">${run["script_path"]}</span>` : nothing}
      </p>

      <tl-state .loading=${this.loading && !d} .error=${this.error}>
        ${d ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: WorkflowDetail) {
    const totalIn = d.agents.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
    const totalReq = d.agents.reduce((a, r) => a + r.requests, 0);
    const cost = d.agents.reduce((a, r) => a + (r.cost_usd ?? 0), 0);

    if (!d.agents.length) {
      return html`
        <tl-state
          empty
          emptyText="No agent turns recorded for this run"
          .emptyHint=${html`The run was recorded but its agents wrote no transcripts under
            <code>subagents/workflows/${this.runId}/</code>.`}
        ></tl-state>
      `;
    }

    return html`
      <div class="stats">
        <tl-stat label="Agents" value=${f.count(d.agentCount)}></tl-stat>
        <tl-stat label="Requests" value=${f.count(totalReq)}></tl-stat>
        <tl-stat label="In + cache" value=${f.short(totalIn)} sub="measured"></tl-stat>
        <tl-stat
          label="Cost"
          value=${cost > 0 ? f.usd(cost) : f.EM_DASH}
          caveat="Null unless the sink was running; transcripts record tokens but no price."
        ></tl-stat>
      </div>

      <div class="grid-2">
        <jh-card header-title="Agents in this run" padding="medium" show-header-divider>
          <tl-bars
            .data=${d.agents.map((r) => ({
              label: r.label ?? r.agent_type ?? f.shortId(r.agent_id, 12),
              value: r.input_tokens,
              detail: `${f.count(r.requests)} requests`,
            }))}
            .format=${(v: number | null) => f.short(v)}
          ></tl-bars>
        </jh-card>

        <jh-card header-title="Tools used" padding="medium" show-header-divider>
          ${d.tools.length
            ? html`
                <tl-bars
                  .data=${d.tools.map((t) => ({ label: t.tool_name ?? "—", value: t.n }))}
                  .format=${(v: number | null) => f.count(v)}
                ></tl-bars>
              `
            : html`<tl-state empty emptyText="No tool calls recorded"></tl-state>`}
        </jh-card>
      </div>

      <jh-card header-title="Detail" padding="medium" show-header-divider>
        <tl-table
          .columns=${this.columns()}
          .rows=${d.agents}
          clickable
          @row-click=${(e: CustomEvent<AgentDetail>) =>
            navigate(this, `/tools?agent=${encodeURIComponent(e.detail.agent_id)}`)}
        ></tl-table>
      </jh-card>
    `;
  }

  private columns(): Column[] {
    return [
      {
        key: "label",
        label: "Agent",
        render: (r: AgentDetail) =>
          html`<span class="mono" title=${r.agent_id}>${r.label ?? f.shortId(r.agent_id, 16)}</span>`,
      },
      {
        key: "agent_type",
        label: "Type",
        render: (r: AgentDetail) => r.agent_type ?? html`<span class="muted">—</span>`,
      },
      { key: "requests", label: "Requests", align: "right", render: (r: AgentDetail) => f.count(r.requests) },
      {
        key: "input_tokens",
        label: "In + cache",
        align: "right",
        render: (r: AgentDetail) => f.short(r.input_tokens),
      },
      {
        key: "output_tokens",
        label: "Out",
        align: "right",
        render: (r: AgentDetail) => f.short(r.output_tokens),
      },
      {
        key: "started_at",
        label: "Started",
        render: (r: AgentDetail) => f.dateTime(r.started_at),
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-workflow": ViewWorkflow;
  }
}
