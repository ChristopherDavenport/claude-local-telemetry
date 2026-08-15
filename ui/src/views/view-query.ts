/**
 * Query builder.
 *
 * The shape is borrowed from Honeycomb deliberately: pick a table, pick a
 * calculation, break it down by a column, filter, then click a bar to drill in.
 * It is the same loop as the `telemetry_run_query` MCP tool because it is the
 * same endpoint — the tool and this form are two front ends over
 * `queries.ts::runQuery`.
 *
 * The whole query lives in the URL, so a result is a link. That is the single
 * feature that makes a query builder worth having over an ad-hoc SQL prompt:
 * you can paste "here is the query that shows the problem" into an issue.
 *
 * `where` is a raw SQL predicate. The server rejects statement separators and
 * anything that writes, but it is otherwise passed through — this is a
 * loopback tool over your own database, and the honest framing is that it is
 * as powerful as the SQL you type.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/button/button.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, AGGS, TABLES, BREAKDOWNS, type QueryResult, type QueryRow } from "../api.js";
import { panel, layout, toolbar } from "../shared.js";
import { navigate } from "../navigate.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-range.js";

/** Aggregations whose result is money, and those whose result is milliseconds. */
const MONEY = new Set(["sum_cost"]);
const DURATION = new Set(["avg_duration", "max_duration", "sum_duration"]);

@customElement("view-query")
export class ViewQuery extends TlView<QueryResult> {
  static override styles = [
    panel,
    layout,
    toolbar,
    css`
      :host {
        display: block;
      }

      h1 {
        margin: 0 0 var(--jh-size-200);
        font-size: var(--jh-font-size-700);
        line-height: var(--jh-font-line-height-900);
        font-weight: 500;
      }

      .lede {
        margin: 0 0 var(--tl-gap);
        color: var(--jh-color-content-secondary-enabled);
        font-size: var(--jh-font-size-350);
        max-width: 70ch;
      }

      jh-card {
        display: block;
      }

      jh-card + jh-card {
        margin-top: var(--tl-gap);
      }

      .where {
        flex: 1 1 320px;
      }

      .where input {
        width: 100%;
        font-family: var(--jh-font-family-mono);
      }

      .sql {
        margin: 0;
        font-family: var(--jh-font-family-mono);
        font-size: var(--jh-font-size-300);
        color: var(--jh-color-content-secondary-enabled);
        overflow-wrap: anywhere;
      }

      .single {
        display: flex;
        justify-content: center;
        padding: var(--jh-size-500) 0;
      }

      .single tl-stat {
        min-width: 260px;
      }

      details {
        margin-top: var(--tl-gap);
      }

      summary {
        cursor: pointer;
        font-size: var(--jh-font-size-400);
        font-weight: 500;
        padding: var(--jh-size-200) 0;
      }

      summary:focus-visible {
        outline: 2px solid var(--jh-color-interactive-focus-outer);
        outline-offset: 2px;
      }

      textarea {
        width: 100%;
        min-height: 96px;
        resize: vertical;
        font-family: var(--jh-font-family-mono);
        font-size: var(--jh-font-size-300);
        line-height: var(--jh-font-line-height-500);
        color: var(--jh-color-content-primary-enabled);
        background: var(--jh-color-container-primary-enabled);
        border: 1px solid var(--jh-color-divider-primary);
        border-radius: var(--jh-border-radius-100);
        padding: var(--jh-size-250);
      }

      textarea:focus-visible {
        outline: 2px solid var(--jh-color-interactive-focus-outer);
        outline-offset: 1px;
      }

      .sql-actions {
        display: flex;
        align-items: center;
        gap: var(--jh-size-300);
        margin-top: var(--jh-size-250);
      }
    `,
  ];

  @state() private table = "api_requests";
  @state() private calculate = "count";
  @state() private breakdown = "";
  @state() private where = "";
  @state() private days: number | null = 30;
  @state() private limit = 25;

  /* Raw SQL runs outside the base class's single-fetch lifecycle: it is a
   * second, independent query on the same page and must not clobber the
   * builder's results or its spinner. */
  @state() private sqlText =
    "SELECT tool_name, count(*) AS n, sum(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures\nFROM tool_calls GROUP BY 1 ORDER BY n DESC";
  @state() private sqlRows: Array<Record<string, unknown>> | null = null;
  @state() private sqlError: string | null = null;
  @state() private sqlBusy = false;

  override connectedCallback() {
    // Restore from the URL before the base class issues its first fetch.
    const p = new URLSearchParams(location.search);
    this.table = p.get("table") ?? this.table;
    this.calculate = p.get("calculate") ?? this.calculate;
    this.breakdown = p.get("breakdown") ?? this.breakdown;
    this.where = p.get("where") ?? this.where;
    const d = p.get("days");
    if (d != null) this.days = d === "all" ? null : Number(d);
    super.connectedCallback();
  }

  protected override fetchData(signal: AbortSignal): Promise<QueryResult> {
    return api.query(
      {
        table: this.table,
        calculate: this.calculate,
        breakdown: this.breakdown || undefined,
        where: this.where || undefined,
        since: sinceFor(this.days),
        limit: this.limit,
      },
      signal,
    );
  }

  /** Run, and make the URL describe the run. */
  private run() {
    const p = new URLSearchParams();
    p.set("table", this.table);
    p.set("calculate", this.calculate);
    if (this.breakdown) p.set("breakdown", this.breakdown);
    if (this.where) p.set("where", this.where);
    p.set("days", this.days == null ? "all" : String(this.days));
    history.replaceState({}, "", `${location.pathname}?${p}`);
    void this.reload();
  }

  private get columns(): readonly string[] {
    return BREAKDOWNS[this.table] ?? [];
  }

  private format = (v: number | null): string => {
    if (v == null) return f.EM_DASH;
    if (MONEY.has(this.calculate)) return f.usd(v);
    if (DURATION.has(this.calculate)) return f.ms(v);
    return f.count(Math.round(v));
  };

  override render() {
    const d = this.data;
    return html`
      <h1>Query</h1>
      <p class="lede">
        The same endpoint the <code>telemetry_run_query</code> tool uses. The query is in the URL,
        so a result is a link.
      </p>

      <jh-card padding="medium">
        <div class="toolbar" style="margin-bottom:0">
          <span class="field">
            <label for="table">Table</label>
            <select
              id="table"
              @change=${(e: Event) => {
                this.table = (e.target as HTMLSelectElement).value;
                // A breakdown from the previous table is almost never a column
                // of the new one, and the server 400s on that rather than
                // ignoring it.
                this.breakdown = "";
                this.run();
              }}
            >
              ${TABLES.map(
                (t) => html`<option value=${t} ?selected=${t === this.table}>${t}</option>`,
              )}
            </select>
          </span>

          <span class="field">
            <label for="calc">Calculate</label>
            <select
              id="calc"
              @change=${(e: Event) => {
                this.calculate = (e.target as HTMLSelectElement).value;
                this.run();
              }}
            >
              ${AGGS.map(
                (a) => html`<option value=${a} ?selected=${a === this.calculate}>${a}</option>`,
              )}
            </select>
          </span>

          <span class="field">
            <label for="breakdown">Breakdown</label>
            <select
              id="breakdown"
              @change=${(e: Event) => {
                this.breakdown = (e.target as HTMLSelectElement).value;
                this.run();
              }}
            >
              <option value="" ?selected=${!this.breakdown}>none</option>
              ${this.columns.map(
                (c) => html`<option value=${c} ?selected=${c === this.breakdown}>${c}</option>`,
              )}
            </select>
          </span>

          <span class="field where">
            <label for="where">Where</label>
            <input
              id="where"
              type="text"
              .value=${this.where}
              placeholder="model LIKE 'claude-opus%'"
              @change=${(e: Event) => {
                this.where = (e.target as HTMLInputElement).value;
                this.run();
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  this.where = (e.target as HTMLInputElement).value;
                  this.run();
                }
              }}
            />
          </span>

          <span class="field">
            <label for="limit">Limit</label>
            <select
              id="limit"
              @change=${(e: Event) => {
                this.limit = Number((e.target as HTMLSelectElement).value);
                this.run();
              }}
            >
              ${[10, 25, 50, 100].map(
                (n) => html`<option value=${n} ?selected=${n === this.limit}>${n}</option>`,
              )}
            </select>
          </span>

          <tl-range
            .days=${this.days}
            @range-change=${(e: CustomEvent<{ days: number | null }>) => {
              this.days = e.detail.days;
              this.run();
            }}
          ></tl-range>

          <jh-button size="small" appearance="secondary" label="Run" @click=${() => this.run()}></jh-button>
        </div>
      </jh-card>

      <jh-card padding="medium">
        <tl-state
          .loading=${this.loading && !d}
          .error=${this.error}
          .empty=${!!d && d.rows.length === 0}
          emptyText="No rows matched"
          .emptyHint=${html`Check the <code>where</code> clause, or widen the range.`}
        >
          ${d && d.rows.length ? this.renderResult(d) : nothing}
        </tl-state>
      </jh-card>

      ${this.renderSql()}
    `;
  }

  /**
   * Raw SELECT.
   *
   * This is the surface the MCP server had as `telemetry_sql` and the dashboard
   * did not, which meant Claude could answer questions here that the UI could
   * not express. Same function, same read-only guard — a single SELECT, no
   * statement separators, no DDL — so the two front ends are finally level.
   *
   * Collapsed by default: the builder covers the common questions, and an open
   * SQL box invites treating the page as a database console.
   */
  private renderSql() {
    return html`
      <details>
        <summary>Raw SQL</summary>
        <jh-card padding="medium">
          <p class="panel-note">
            One read-only <code>SELECT</code>. Tables:
            ${TABLES.map((t) => html`<code>${t}</code> `)}
          </p>
          <textarea
            .value=${this.sqlText}
            spellcheck="false"
            aria-label="SQL query"
            @input=${(e: Event) => (this.sqlText = (e.target as HTMLTextAreaElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              // Enter inserts a newline in a textarea, so the run shortcut needs
              // a modifier — the same one editors use.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void this.runSql();
              }
            }}
          ></textarea>
          <div class="sql-actions">
            <!-- "Run SQL", not "Run": the builder above has its own Run, and two
                 identically-labelled buttons on one page is a screen-reader trap. -->
            <jh-button
              size="small"
              appearance="secondary"
              label="Run SQL"
              ?pending=${this.sqlBusy}
              @click=${() => void this.runSql()}
            ></jh-button>
            <span class="panel-note" style="margin:0">⌘/Ctrl + Enter · 200 rows max</span>
          </div>

          ${this.sqlError
            ? html`
                <jh-notification
                  appearance="negative"
                  type="alert"
                  hide-dismiss-button
                  style="display:block; margin-top: var(--tl-gap)"
                >
                  ${this.sqlError}
                </jh-notification>
              `
            : nothing}
          ${this.sqlRows ? html`<div style="margin-top: var(--tl-gap)">
              ${this.renderSqlRows(this.sqlRows)}
            </div>` : nothing}
        </jh-card>
      </details>
    `;
  }

  private async runSql() {
    this.sqlBusy = true;
    this.sqlError = null;
    try {
      const r = await api.sql({ query: this.sqlText, limit: 200 });
      this.sqlRows = r.rows;
    } catch (err) {
      this.sqlError = (err as Error).message;
      this.sqlRows = null;
    } finally {
      this.sqlBusy = false;
    }
  }

  /** Columns come from the result, since the shape is whatever was asked for. */
  private renderSqlRows(rows: Array<Record<string, unknown>>) {
    if (!rows.length) return html`<tl-state empty emptyText="No rows"></tl-state>`;
    const first = rows[0]!;
    const cols: Column[] = Object.keys(first).map((k) => ({
      key: k,
      label: k,
      align: typeof first[k] === "number" ? ("right" as const) : ("left" as const),
      render: (r: Record<string, unknown>) => {
        const v = r[k];
        if (v == null) return html`<span class="muted">null</span>`;
        if (typeof v === "number") return f.count(v);
        return String(v);
      },
    }));
    return html`
      <tl-table
        caption=${`${rows.length} row${rows.length === 1 ? "" : "s"}`}
        .columns=${cols}
        .rows=${rows}
      ></tl-table>
    `;
  }

  private renderResult(d: QueryResult) {
    const label = `${d.calculate} of ${d.table}`;

    // No breakdown means one number. The form heuristic says that is a stat
    // tile, not a one-bar chart.
    if (!d.breakdown) {
      return html`
        <div class="single">
          <tl-stat label=${label} value=${this.format(d.rows[0]?.value ?? null)}></tl-stat>
        </div>
      `;
    }

    const drillable = d.breakdown === "session_id";
    return html`
      <p class="sql">
        SELECT ${d.breakdown}, ${d.calculate} FROM ${d.table}${this.where ? ` WHERE ${this.where}` : ""}
        GROUP BY ${d.breakdown}
      </p>
      <tl-bars
        .data=${d.rows.map((r) => ({
          label: r.grp == null ? "(null)" : String(r.grp),
          value: r.value,
          id: r.grp == null ? "" : String(r.grp),
        }))}
        .format=${this.format}
        ?clickable=${drillable}
        @bar-click=${(e: CustomEvent<{ id?: string }>) =>
          e.detail.id && navigate(this, `/sessions/${e.detail.id}`)}
      ></tl-bars>

      <div style="margin-top: var(--tl-gap)">
        <tl-table
          .columns=${[
            {
              key: "grp",
              label: d.breakdown,
              render: (r: QueryRow) =>
                r.grp == null ? html`<span class="muted">(null)</span>` : String(r.grp),
            },
            {
              key: "value",
              label: d.calculate,
              align: "right" as const,
              render: (r: QueryRow) => this.format(r.value),
            },
          ] satisfies Column[]}
          .rows=${d.rows}
          ?clickable=${drillable}
          @row-click=${(e: CustomEvent<QueryRow>) =>
            e.detail.grp && navigate(this, `/sessions/${String(e.detail.grp)}`)}
        ></tl-table>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-query": ViewQuery;
  }
}
