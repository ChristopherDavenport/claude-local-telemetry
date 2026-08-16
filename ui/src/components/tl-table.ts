/**
 * The data table.
 *
 * jh-ui has no table component — the design system documents one but the
 * package does not ship it — so this is built from tokens rather than invented
 * against an API that isn't there. Six views render one of these, which is
 * why it lives here instead of being repeated.
 *
 * Sorting starts *off*. The server already orders every result meaningfully
 * (cost descending, timestamp descending, errors first), and re-sorting on
 * arrival would throw that away before the reader saw it. Clicking a header
 * opts in.
 */

import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { table as tableStyles } from "../shared.js";

/** `nothing` is included: a cell that renders empty is a normal outcome. */
export type Cell = TemplateResult | string | number | null | typeof nothing;

export interface Column {
  /** Identity for sort state; also the default value accessor. */
  key: string;
  label: string;
  align?: "left" | "right";
  /** Set false for columns whose order carries no meaning. */
  sortable?: boolean;
  /** Sort key. Defaults to `row[key]`. */
  value?: (row: never) => number | string | null;
  /** Cell contents. Defaults to the stringified raw value. */
  render?: (row: never) => Cell;
  /** A CSS width, when a column would otherwise collapse or hog. */
  width?: string;
}

type Row = Record<string, unknown>;

@customElement("tl-table")
export class TlTable extends LitElement {
  static override styles = [
    tableStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) columns: Column[] = [];
  @property({ attribute: false }) rows: Row[] = [];
  /** Emits `row-click` and shows a pointer cursor. */
  @property({ type: Boolean }) clickable = false;
  @property({ type: String }) caption = "";

  @state() private sortKey: string | null = null;
  @state() private sortDesc = true;

  private get sorted(): Row[] {
    const key = this.sortKey;
    if (!key) return this.rows;
    const col = this.columns.find((c) => c.key === key);
    if (!col) return this.rows;
    const accessor = col.value ?? ((r: Row) => r[key] as number | string | null);
    const dir = this.sortDesc ? -1 : 1;

    // Copy before sorting: `rows` is the caller's array and mutating it would
    // reorder their data as a side effect of a click in here.
    return [...this.rows].sort((a, b) => {
      const av = (accessor as (r: Row) => number | string | null)(a);
      const bv = (accessor as (r: Row) => number | string | null)(b);
      // Nulls sort last in both directions. They mean "not recorded", and
      // floating them to the top of a descending cost column would imply they
      // were the most expensive.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  private toggle(col: Column) {
    if (col.sortable === false) return;
    if (this.sortKey === col.key) {
      this.sortDesc = !this.sortDesc;
    } else {
      this.sortKey = col.key;
      this.sortDesc = true;
    }
  }

  /**
   * Not named `ariaSort`: `HTMLElement` already has a property by that name
   * (the ARIA reflection API), and shadowing it with a method changes the
   * element's public shape.
   */
  private sortStateOf(col: Column): "ascending" | "descending" | "none" {
    if (this.sortKey !== col.key) return "none";
    return this.sortDesc ? "descending" : "ascending";
  }

  override render() {
    const rows = this.sorted;
    return html`
      <div class="scroll">
        <table>
          ${this.caption ? html`<caption>${this.caption}</caption>` : nothing}
          <thead>
            <tr>
              ${this.columns.map(
                (c) => html`
                  <th
                    class=${c.align === "right" ? "num" : ""}
                    style=${c.width ? `width:${c.width}` : ""}
                    aria-sort=${this.sortStateOf(c)}
                  >
                    ${c.sortable === false
                      ? c.label
                      : html`
                          <button
                            type="button"
                            @click=${() => this.toggle(c)}
                            title="Sort by ${c.label}"
                          >
                            ${c.label}
                            <span class="sort-arrow" aria-hidden="true"
                              >${this.sortKey === c.key ? (this.sortDesc ? "▾" : "▴") : ""}</span
                            >
                          </button>
                        `}
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${repeat(
              rows,
              (r, i) => String(r["session_id"] ?? r["grp"] ?? r["hook_name"] ?? r["ts"] ?? i),
              (r) => html`
                <tr
                  class=${this.clickable ? "clickable" : ""}
                  tabindex=${this.clickable ? "0" : "-1"}
                  @click=${() => this.emit(r)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (this.clickable && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      this.emit(r);
                    }
                  }}
                >
                  ${this.columns.map(
                    (c) => html`
                      <td class=${c.align === "right" ? "num" : ""}>
                        ${c.render
                          ? (c.render as (row: Row) => Cell)(r)
                          : (r[c.key] as Cell) ?? html`<span class="muted">—</span>`}
                      </td>
                    `,
                  )}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private emit(row: Row) {
    if (!this.clickable) return;
    this.dispatchEvent(
      new CustomEvent<Row>("row-click", { detail: row, bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tl-table": TlTable;
  }
}
