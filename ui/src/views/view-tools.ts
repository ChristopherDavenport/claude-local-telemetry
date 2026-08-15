/**
 * Tool audit — what the agent did, and who let it.
 *
 * `decision` and `decision_source` are the columns that make this an audit
 * rather than a usage report: they record whether a call was allowed by a
 * rule, by a prompt, or by nothing at all. They only exist on OTel-sourced
 * rows, so a store built purely from backfilled transcripts shows them empty.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/tag/tag.js";

import { TlView } from "../view-base.js";
import { api, type ToolAudit, type ToolRow, type ToolSummaryRow } from "../api.js";
import { panel, layout, toolbar } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-range.js";

type SuccessFilter = "any" | "true" | "false";

@customElement("view-tools")
export class ViewTools extends TlView<ToolAudit> {
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

      jh-card + jh-card {
        margin-top: var(--tl-gap);
      }

      .mono {
        font-family: var(--jh-font-family-mono);
        font-size: var(--jh-font-size-300);
      }

      .muted {
        color: var(--jh-color-content-secondary-enabled);
      }
    `,
  ];

  @state() private days: number | null = 7;
  @state() private toolName = "";
  @state() private decision = "";
  @state() private success: SuccessFilter = "any";
  @state() private limit = 100;

  protected override fetchData(signal: AbortSignal): Promise<ToolAudit> {
    return api.tools(
      {
        since: sinceFor(this.days),
        toolName: this.toolName || undefined,
        decision: this.decision || undefined,
        success: this.success === "any" ? undefined : this.success === "true",
        limit: this.limit,
      },
      signal,
    );
  }

  override render() {
    const d = this.data;
    return html`
      <h1>Tool audit</h1>

      <div class="toolbar">
        <span class="field">
          <label for="tool">Tool</label>
          <select
            id="tool"
            @change=${(e: Event) => {
              this.toolName = (e.target as HTMLSelectElement).value;
              void this.reload();
            }}
          >
            <option value="">All tools</option>
            ${(d?.summary ?? []).map(
              (s) => html`
                <option value=${s.tool_name ?? ""} ?selected=${s.tool_name === this.toolName}>
                  ${s.tool_name} (${s.n})
                </option>
              `,
            )}
          </select>
        </span>

        <span class="field">
          <label for="decision">Decision</label>
          <select
            id="decision"
            @change=${(e: Event) => {
              this.decision = (e.target as HTMLSelectElement).value;
              void this.reload();
            }}
          >
            ${["", "allow", "deny", "ask"].map(
              (v) => html`
                <option value=${v} ?selected=${v === this.decision}>${v || "Any decision"}</option>
              `,
            )}
          </select>
        </span>

        <span class="field">
          <label for="success">Outcome</label>
          <select
            id="success"
            @change=${(e: Event) => {
              this.success = (e.target as HTMLSelectElement).value as SuccessFilter;
              void this.reload();
            }}
          >
            <option value="any" ?selected=${this.success === "any"}>Any</option>
            <option value="true" ?selected=${this.success === "true"}>Succeeded</option>
            <option value="false" ?selected=${this.success === "false"}>Failed</option>
          </select>
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

      <tl-state
        .loading=${this.loading && !d}
        .error=${this.error}
        .empty=${!!d && d.rows.length === 0 && d.summary.length === 0}
        emptyText="No tool calls match"
      >
        ${d ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: ToolAudit) {
    const failing = d.summary.filter((s) => s.failures > 0);
    return html`
      <jh-card header-title="Calls by tool" padding="medium" show-header-divider>
        ${d.summary.length
          ? html`
              <tl-bars
                .data=${d.summary.map((s: ToolSummaryRow) => ({
                  label: s.tool_name ?? "—",
                  value: s.n,
                  detail: s.failures
                    ? `${s.failures} failed (${f.percent(s.failures / s.n, 1)})`
                    : "no failures",
                  id: s.tool_name ?? "",
                }))}
                .format=${(v: number | null) => f.count(v)}
                clickable
                @bar-click=${(e: CustomEvent<{ id?: string }>) => {
                  this.toolName = e.detail.id ?? "";
                  void this.reload();
                }}
              ></tl-bars>
              ${failing.length
                ? html`<p class="panel-note" style="margin: var(--jh-size-300) 0 0">
                    ${failing.length} tool${failing.length === 1 ? " has" : "s have"} failures in
                    this range — click a bar to filter.
                  </p>`
                : nothing}
            `
          : html`<tl-state empty emptyText="No tool calls in this range"></tl-state>`}
      </jh-card>

      <jh-card header-title="Calls" padding="medium" show-header-divider>
        <tl-table
          caption=${`${d.rows.length} most recent`}
          .columns=${this.columns()}
          .rows=${d.rows}
          clickable
          @row-click=${(e: CustomEvent<ToolRow>) =>
            e.detail.session_id && navigate(this, `/sessions/${e.detail.session_id}`)}
        ></tl-table>
      </jh-card>
    `;
  }

  private columns(): Column[] {
    return [
      { key: "ts", label: "When", render: (r: ToolRow) => html`<span title=${r.ts}>${f.dateTime(r.ts)}</span>` },
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
        render: (r: ToolRow) =>
          r.decision
            ? html`<jh-tag size="small" label=${r.decision}></jh-tag>`
            : html`<span class="muted">—</span>`,
      },
      {
        key: "decision_source",
        label: "Source",
        render: (r: ToolRow) =>
          r.decision_source
            ? html`<span class="mono">${r.decision_source}</span>`
            : html`<span class="muted">—</span>`,
      },
      { key: "duration_ms", label: "Duration", align: "right", render: (r: ToolRow) => f.ms(r.duration_ms) },
      { key: "input_bytes", label: "In", align: "right", render: (r: ToolRow) => f.bytes(r.input_bytes) },
      { key: "result_bytes", label: "Out", align: "right", render: (r: ToolRow) => f.bytes(r.result_bytes) },
      {
        key: "cwd",
        label: "Directory",
        render: (r: ToolRow) => html`<span title=${r.cwd ?? ""}>${f.shortPath(r.cwd)}</span>`,
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-tools": ViewTools;
  }
}
