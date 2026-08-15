/**
 * Overview — what is in the store, and over what period.
 *
 * Deliberately the landing page and deliberately first: the same reason
 * `telemetry_overview` is the tool to call first. Whether a question is
 * answerable at all depends on which source the rows came from, so the
 * source split is stated up front rather than buried in a footnote.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, type Overview, type CostResult, type HookHealth, type SessionRow } from "../api.js";
import { panel, layout } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";
import type { Bucket, Series } from "../components/tl-timeseries.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-timeseries.js";
import "../components/tl-range.js";

interface Data {
  overview: Overview;
  byDay: CostResult;
  byModel: CostResult;
  hooks: HookHealth;
  sessions: { rows: SessionRow[] };
}

const TOKEN_SERIES: Series[] = [
  { label: "Input", color: "var(--tl-series-1)" },
  { label: "Output", color: "var(--tl-series-2)" },
  { label: "Cache read", color: "var(--tl-series-3)" },
  { label: "Cache creation", color: "var(--tl-series-4)" },
];

@customElement("view-overview")
export class ViewOverview extends TlView<Data> {
  static override styles = [
    panel,
    layout,
    css`
      :host {
        display: block;
      }

      .stats {
        display: grid;
        gap: var(--tl-gap);
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        margin-bottom: var(--tl-gap);
      }

      jh-notification {
        display: block;
        margin-bottom: var(--tl-gap);
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
    `,
  ];

  @state() private days: number | null = 30;

  protected override async fetchData(signal: AbortSignal): Promise<Data> {
    const since = sinceFor(this.days);
    const [overview, byDay, byModel, hooks, sessions] = await Promise.all([
      api.overview(signal),
      api.cost({ groupBy: "day", since, limit: 120 }, signal),
      api.cost({ groupBy: "model", since, limit: 8 }, signal),
      api.hooks({ since }, signal),
      api.sessions({ since, limit: 8 }, signal),
    ]);
    return { overview, byDay, byModel, hooks, sessions };
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <h1>Overview</h1>
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
    const o = d.overview;
    const sources = Object.entries(o.bySource);
    const otel = o.bySource["otel"] ?? 0;
    const total = sources.reduce((a, [, n]) => a + n, 0);

    return html`
      <div class="stats">
        <tl-stat
          label="Cost"
          value=${f.usd(o.totalCostUsd)}
          sub=${`${f.percent(total ? otel / total : null)} of rows carry dollars`}
          caveat="Only OTel-sourced rows record cost. Transcript rows have exact tokens but no price, so this total covers the period the sink was running."
        ></tl-stat>
        <tl-stat
          label="API requests"
          value=${f.count(o.rows["api_requests"])}
          sub=${o.timeRange.from ? `since ${f.day(o.timeRange.from)}` : ""}
        ></tl-stat>
        <tl-stat label="Tool calls" value=${f.count(o.rows["tool_calls"])}></tl-stat>
        <tl-stat label="Sessions" value=${f.count(o.rows["sessions"])}></tl-stat>
        <tl-stat
          label="Hook errors"
          value=${f.count(d.hooks.totalErrors)}
          tone=${d.hooks.totalErrors > 0 ? "negative" : "positive"}
          sub=${d.hooks.totalErrors > 0 ? "guards that did not apply" : "all runs clean"}
          caveat="A hook exiting non-zero with anything but 2 is a non-blocking error: the tool call it guards still ran."
        ></tl-stat>
        <tl-stat
          label="Spans"
          value=${f.count(o.rows["spans"])}
          sub=${o.rows["spans"] ? "" : "traces are a beta exporter"}
        ></tl-stat>
      </div>

      <jh-notification appearance="neutral" type="alert" hide-dismiss-button>
        ${o.note}
      </jh-notification>

      <div class="grid-2">
        <jh-card header-title="Tokens over time" padding="medium" show-header-divider>
          ${this.renderTokens(d.byDay)}
        </jh-card>

        <jh-card header-title="Cost over time" padding="medium" show-header-divider>
          ${this.renderCost(d.byDay)}
        </jh-card>
      </div>

      <div class="grid-2" style="margin-top: var(--tl-gap)">
        <jh-card header-title="Cost by model" padding="medium" show-header-divider>
          ${this.renderModels(d.byModel)}
        </jh-card>

        <jh-card header-title="Recent sessions" padding="medium" show-header-divider>
          ${this.renderSessions(d.sessions.rows)}
        </jh-card>
      </div>
    `;
  }

  /** The server orders cost rows by spend; a time axis needs them by date. */
  private chronological(r: CostResult) {
    return [...r.rows].sort((a, b) => String(a.grp).localeCompare(String(b.grp)));
  }

  private renderTokens(r: CostResult) {
    const rows = this.chronological(r);
    if (!rows.length) return this.noData();
    const buckets: Bucket[] = rows.map((row) => ({
      label: f.day(row.grp),
      values: [
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        row.cache_read ?? 0,
        row.cache_creation ?? 0,
      ],
    }));
    return html`
      <tl-timeseries
        label="Tokens per day by kind"
        .series=${TOKEN_SERIES}
        .buckets=${buckets}
        .format=${(v: number) => f.short(v)}
      ></tl-timeseries>
    `;
  }

  private renderCost(r: CostResult) {
    const rows = this.chronological(r).filter((x) => x.cost_usd != null);
    if (!rows.length) {
      return html`
        <tl-state
          empty
          emptyText="No cost recorded in this range"
          .emptyHint=${html`Cost arrives only from the OTLP sink. Start it with
            <code>claude-local-telemetry sink</code> and point Claude Code at it.`}
        ></tl-state>
      `;
    }
    const buckets: Bucket[] = rows.map((row) => ({
      label: f.day(row.grp),
      values: [row.cost_usd ?? 0],
    }));
    return html`
      <tl-timeseries
        label="Cost per day"
        .series=${[{ label: "Cost", color: "var(--tl-series-2)" }]}
        .buckets=${buckets}
        .format=${(v: number) => f.usd(v)}
      ></tl-timeseries>
    `;
  }

  private renderModels(r: CostResult) {
    if (!r.rows.length) return this.noData();
    const anyCost = r.rows.some((x) => x.cost_usd != null);
    return html`
      <tl-bars
        .data=${r.rows.map((x) => ({
          label: x.grp ?? "unknown",
          value: anyCost ? x.cost_usd : x.input_tokens,
          detail: `${f.count(x.n)} requests · ${f.short(x.input_tokens)} in · ${f.short(x.output_tokens)} out`,
        }))}
        .format=${anyCost ? (v: number | null) => f.usd(v) : (v: number | null) => f.short(v)}
      ></tl-bars>
      <p class="panel-note" style="margin-top: var(--jh-size-300); margin-bottom:0">
        ${anyCost ? "By cost." : "No cost in range — showing input tokens instead."}
      </p>
    `;
  }

  private renderSessions(rows: SessionRow[]) {
    if (!rows.length) return this.noData();
    const cols: Column[] = [
      {
        key: "started_at",
        label: "Started",
        render: (r: SessionRow) => f.relative(r.started_at),
      },
      {
        key: "cwd",
        label: "Directory",
        render: (r: SessionRow) => html`<span title=${r.cwd ?? ""}>${f.shortPath(r.cwd)}</span>`,
      },
      { key: "requests", label: "Reqs", align: "right" },
      {
        key: "cost_usd",
        label: "Cost",
        align: "right",
        render: (r: SessionRow) => f.usd(r.cost_usd),
      },
    ];
    return html`
      <tl-table
        .columns=${cols}
        .rows=${rows}
        clickable
        @row-click=${(e: CustomEvent<SessionRow>) => navigate(this, `/sessions/${e.detail.session_id}`)}
      ></tl-table>
    `;
  }

  private noData() {
    return html`<tl-state empty emptyText="No rows in this range"></tl-state>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-overview": ViewOverview;
  }
}
