/**
 * Hook health.
 *
 * The highest-value screen here, for a reason worth restating on the page
 * itself: a hook that exits non-zero with anything other than 2 is a
 * *non-blocking* error, so the tool call it was guarding proceeds. A hook can
 * therefore fail on every single invocation and leave no trace in the session.
 *
 * That is not hypothetical — it is how two of three hooks in a companion safety
 * plugin were found to have never executed across two releases. `errored` is
 * the column; everything else here is context for it.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";

import { TlView } from "../view-base.js";
import { api, type HookHealth, type HookRow } from "../api.js";
import { panel, layout } from "../shared.js";
import * as f from "../format.js";
import { sinceFor } from "../components/tl-range.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";
import "../components/tl-range.js";

@customElement("view-hooks")
export class ViewHooks extends TlView<HookHealth> {
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

      jh-notification {
        display: block;
        margin-bottom: var(--tl-gap);
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

      jh-card + jh-card {
        margin-top: var(--tl-gap);
      }

      tr.bad td {
        background: var(--jh-color-container-negative-enabled);
      }
    `,
  ];

  @state() private days: number | null = 30;

  protected override fetchData(signal: AbortSignal): Promise<HookHealth> {
    return api.hooks({ since: sinceFor(this.days), limit: 100 }, signal);
  }

  override render() {
    const d = this.data;
    return html`
      <div class="head">
        <h1>Hook health</h1>
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
        .empty=${!!d && d.runs === 0}
        emptyText="No hook telemetry yet"
        .emptyHint=${html`Hook runs are reported only by OTel — the transcripts do not record
          them. Start the sink with <code>claude-local-telemetry sink</code>.`}
      >
        ${d && d.runs > 0 ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: HookHealth) {
    const bad = d.totalErrors > 0;
    return html`
      <jh-notification
        appearance=${bad ? "negative" : "positive"}
        type="alert"
        hide-dismiss-button
      >
        ${d.verdict}
      </jh-notification>

      <div class="stats">
        <tl-stat label="Hook runs" value=${f.count(d.runs)}></tl-stat>
        <tl-stat
          label="Errors"
          value=${f.count(d.totalErrors)}
          tone=${bad ? "negative" : "positive"}
          sub=${bad ? "the guarded calls still ran" : "none"}
        ></tl-stat>
        <tl-stat
          label="Hooks failing"
          value=${f.count(d.failing.length)}
          tone=${d.failing.length ? "negative" : "positive"}
        ></tl-stat>
        <tl-stat
          label="Distinct hooks"
          value=${f.count(new Set(d.byHook.map((h) => h.hook_name)).size)}
        ></tl-stat>
      </div>

      ${d.failing.length
        ? html`
            <jh-card header-title="Failing" padding="medium" show-header-divider>
              <p class="panel-note">${d.note}</p>
              <tl-bars
                .data=${d.failing.map((h) => ({
                  label: `${h.hook_name ?? "—"} · ${h.hook_event ?? ""}`,
                  value: h.errored,
                  detail: `${f.count(h.runs)} runs, ${f.count(h.succeeded)} succeeded`,
                }))}
                .format=${(v: number | null) => `${f.count(v)} errors`}
              ></tl-bars>
            </jh-card>
          `
        : nothing}

      <jh-card header-title="All hooks" padding="medium" show-header-divider>
        <tl-table .columns=${this.columns()} .rows=${d.byHook}></tl-table>
      </jh-card>
    `;
  }

  private columns(): Column[] {
    return [
      { key: "hook_name", label: "Hook" },
      { key: "hook_event", label: "Event" },
      { key: "runs", label: "Runs", align: "right", render: (r: HookRow) => f.count(r.runs) },
      {
        key: "hooks_invoked",
        label: "Invoked",
        align: "right",
        render: (r: HookRow) => f.count(r.hooks_invoked),
      },
      {
        key: "succeeded",
        label: "Succeeded",
        align: "right",
        render: (r: HookRow) => f.count(r.succeeded),
      },
      {
        key: "errored",
        label: "Errored",
        align: "right",
        render: (r: HookRow) =>
          (r.errored ?? 0) > 0
            ? html`<strong class="negative">${f.count(r.errored)}</strong>`
            : html`<span class="muted">0</span>`,
      },
      {
        key: "blocked",
        label: "Blocked",
        align: "right",
        render: (r: HookRow) => f.count(r.blocked),
      },
      { key: "avg_ms", label: "Avg", align: "right", render: (r: HookRow) => f.ms(r.avg_ms) },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-hooks": ViewHooks;
  }
}
