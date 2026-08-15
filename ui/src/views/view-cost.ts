/**
 * Cost — spend and token composition, grouped by anything the server allows.
 *
 * The chart form follows the grouping rather than being fixed: `day` and `hour`
 * are ordered and get columns over time; everything else is unordered
 * categories and gets horizontal bars. Drawing a time series over models would
 * imply a sequence that isn't there.
 *
 * The table under the chart is not redundant. It is the accessible view of the
 * same numbers, and it carries the columns the chart deliberately leaves out —
 * cache ratio above all, which is a ratio and has no business in a stack of
 * absolute token counts.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";

import { TlView } from "../view-base.js";
import { api, COST_GROUPS, type CostResult, type CostRow } from "../api.js";
import { panel, layout, toolbar } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";
import type { Bucket, Series } from "../components/tl-timeseries.js";

import "../components/tl-state.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-timeseries.js";
import "../components/tl-range.js";

const TOKEN_SERIES: Series[] = [
  { label: "Input", color: "var(--tl-series-1)" },
  { label: "Output", color: "var(--tl-series-2)" },
  { label: "Cache read", color: "var(--tl-series-3)" },
  { label: "Cache creation", color: "var(--tl-series-4)" },
];

const TEMPORAL = new Set(["day", "hour"]);

@customElement("view-cost")
export class ViewCost extends TlView<CostResult> {
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
    `,
  ];

  @state() private groupBy = "day";
  @state() private days: number | null = 30;

  protected override fetchData(signal: AbortSignal): Promise<CostResult> {
    return api.cost(
      { groupBy: this.groupBy, since: sinceFor(this.days), limit: TEMPORAL.has(this.groupBy) ? 120 : 25 },
      signal,
    );
  }

  override render() {
    return html`
      <h1>Cost</h1>

      <div class="toolbar">
        <span class="field">
          <label for="group">Group by</label>
          <select
            id="group"
            .value=${this.groupBy}
            @change=${(e: Event) => {
              this.groupBy = (e.target as HTMLSelectElement).value;
              void this.reload();
            }}
          >
            ${COST_GROUPS.map(
              (g) => html`<option value=${g} ?selected=${g === this.groupBy}>${g}</option>`,
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
        .loading=${this.loading && !this.data}
        .error=${this.error}
        .empty=${!!this.data && this.data.rows.length === 0}
        emptyText="No requests in this range"
      >
        ${this.data && this.data.rows.length ? this.renderData(this.data) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: CostResult) {
    const temporal = TEMPORAL.has(d.groupBy);
    const rows = temporal
      ? [...d.rows].sort((a, b) => String(a.grp).localeCompare(String(b.grp)))
      : d.rows;
    const anyCost = rows.some((r) => r.cost_usd != null);

    return html`
      <jh-card header-title="Tokens by ${d.groupBy}" padding="medium" show-header-divider>
        ${temporal
          ? html`
              <tl-timeseries
                label="Tokens per ${d.groupBy} by kind"
                .series=${TOKEN_SERIES}
                .buckets=${rows.map(
                  (r): Bucket => ({
                    label: d.groupBy === "day" ? f.day(r.grp) : (r.grp ?? "").slice(11) + ":00",
                    values: [
                      r.input_tokens ?? 0,
                      r.output_tokens ?? 0,
                      r.cache_read ?? 0,
                      r.cache_creation ?? 0,
                    ],
                  }),
                )}
                .format=${(v: number) => f.short(v)}
              ></tl-timeseries>
            `
          : html`
              <tl-bars
                .data=${rows.map((r) => ({
                  label: r.grp ?? "—",
                  value: anyCost ? r.cost_usd : (r.input_tokens ?? 0) + (r.cache_read ?? 0),
                  detail: `${f.count(r.n)} requests · cache ratio ${f.percent(f.cacheRatio(r))}`,
                  id: r.grp ?? "",
                }))}
                .format=${anyCost ? (v: number | null) => f.usd(v) : (v: number | null) => f.short(v)}
                ?clickable=${d.groupBy === "session_id"}
                @bar-click=${(e: CustomEvent<{ id?: string }>) =>
                  e.detail.id && navigate(this, `/sessions/${e.detail.id}`)}
              ></tl-bars>
              ${anyCost
                ? nothing
                : html`<p class="panel-note" style="margin: var(--jh-size-300) 0 0">
                    No cost recorded in this range — bars show input plus cache-read tokens.
                  </p>`}
            `}
      </jh-card>

      <jh-card header-title="Detail" padding="medium" show-header-divider>
        <tl-table
          .columns=${this.columns(d.groupBy)}
          .rows=${rows}
          ?clickable=${d.groupBy === "session_id"}
          @row-click=${(e: CustomEvent<CostRow>) =>
            e.detail.grp && navigate(this, `/sessions/${e.detail.grp}`)}
        ></tl-table>
      </jh-card>
    `;
  }

  private columns(groupBy: string): Column[] {
    return [
      {
        key: "grp",
        label: groupBy,
        render: (r: CostRow) =>
          html`<span title=${r.grp ?? ""}
            >${groupBy === "cwd" ? f.shortPath(r.grp) : (r.grp ?? "—")}</span
          >`,
      },
      { key: "n", label: "Requests", align: "right", render: (r: CostRow) => f.count(r.n) },
      {
        key: "cost_usd",
        label: "Cost",
        align: "right",
        render: (r: CostRow) => f.usd(r.cost_usd),
      },
      {
        key: "input_tokens",
        label: "Input",
        align: "right",
        render: (r: CostRow) => f.short(r.input_tokens),
      },
      {
        key: "output_tokens",
        label: "Output",
        align: "right",
        render: (r: CostRow) => f.short(r.output_tokens),
      },
      {
        key: "cache_read",
        label: "Cache read",
        align: "right",
        render: (r: CostRow) => f.short(r.cache_read),
      },
      {
        key: "cache_creation",
        label: "Cache create",
        align: "right",
        render: (r: CostRow) => f.short(r.cache_creation),
      },
      {
        key: "ratio",
        label: "Cache ratio",
        align: "right",
        value: (r: CostRow) => f.cacheRatio(r),
        render: (r: CostRow) => f.percent(f.cacheRatio(r)),
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-cost": ViewCost;
  }
}
