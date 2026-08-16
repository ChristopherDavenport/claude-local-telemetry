/**
 * Plugin attribution.
 *
 * This page exists mostly to be honest about what it cannot tell you. OTel
 * reports every plugin outside the official marketplace as the literal string
 * `third-party` on `plugin.name`, `skill.name` and `marketplace.name`, so
 * per-plugin spend for your own plugins is blinded by default.
 *
 * `plugin_id_hash` survives the redaction and is stable per plugin, which is
 * what makes the `plugin_alias` table useful: map hash to name once and the
 * spend attributes. Until then the blinded total is shown as its own figure
 * rather than folded into an "unknown" row, because a confident zero would be
 * the wrong answer.
 *
 * The transcript-derived invocation counts are the reliable signal in the
 * meantime — transcripts are not redacted.
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import "@jack-henry/jh-ui/components/card/card.js";
import "@jack-henry/jh-ui/components/notification/notification.js";
import "@jack-henry/jh-ui/components/tag/tag.js";
import "@jack-henry/jh-ui/components/button/button.js";

import { TlView } from "../view-base.js";
import { api, type PluginCosts, type PluginHashRow, type InvocationRow } from "../api.js";
import { panel, layout } from "../shared.js";
import * as f from "../format.js";
import type { Column } from "../components/tl-table.js";

import "../components/tl-state.js";
import "../components/tl-stat.js";
import "../components/tl-table.js";
import "../components/tl-bars.js";

@customElement("view-plugins")
export class ViewPlugins extends TlView<PluginCosts> {
  static override styles = [
    panel,
    layout,
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

      jh-notification {
        display: block;
        margin-bottom: var(--tl-gap);
      }

      .stats {
        display: grid;
        gap: var(--tl-gap);
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        margin-bottom: var(--tl-gap);
      }

      jh-card {
        display: block;
      }

      jh-card + jh-card,
      .grid-2 + jh-card {
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

  /** Which hash was last copied, so the button can confirm it happened. */
  @state() private copied: string | null = null;

  /**
   * The HTTP API is read-only by design — it is unauthenticated and bound to
   * loopback, and adding a write route to un-blind a plugin is not worth
   * changing that posture for. So this hands over the exact CLI command.
   */
  private async copyAlias(hash: string) {
    const cmd = `claude-local-telemetry alias set ${hash} <name>`;
    try {
      await navigator.clipboard.writeText(cmd);
      this.copied = hash;
      setTimeout(() => { if (this.copied === hash) this.copied = null; }, 2000);
    } catch {
      // Clipboard access needs a secure context; loopback http qualifies, but a
      // browser may still refuse. A prompt beats failing silently.
      window.prompt("Run this, replacing <name>:", cmd);
    }
  }

  protected override fetchData(signal: AbortSignal): Promise<PluginCosts> {
    return api.plugins(signal);
  }

  override render() {
    const d = this.data;
    return html`
      <h1>Plugins</h1>
      <tl-state .loading=${this.loading && !d} .error=${this.error}>
        ${d ? this.renderData(d) : nothing}
      </tl-state>
    `;
  }

  private renderData(d: PluginCosts) {
    const unresolved = d.pluginHashes.filter(
      (h) => h.plugin_name === "third-party" && !h.resolved,
    ).length;

    return html`
      ${unresolved > 0
        ? html`
            <jh-notification appearance="neutral" type="alert" hide-dismiss-button>
              ${d.note}
            </jh-notification>
          `
        : nothing}

      <div class="stats">
        <tl-stat
          label="Attributed"
          value=${f.usd(d.attributed.reduce((a, r) => a + (r.cost_usd ?? 0), 0))}
          sub=${`${d.attributed.length} plugins`}
        ></tl-stat>
        <tl-stat
          label="Blinded"
          value=${f.usd(d.blinded.costUsd)}
          sub=${`${f.count(d.blinded.requests)} requests reported as "third-party"`}
          tone=${d.blinded.requests > 0 ? "negative" : "neutral"}
          caveat="OTel redacts the name of every plugin outside the official marketplace. Populate plugin_alias to attribute this."
        ></tl-stat>
        <tl-stat
          label="Unmapped hashes"
          value=${f.count(unresolved)}
          tone=${unresolved > 0 ? "negative" : "positive"}
        ></tl-stat>
      </div>

      <div class="grid-2">
        <jh-card header-title="Cost by plugin" padding="medium" show-header-divider>
          ${d.attributed.length
            ? html`
                <tl-bars
                  .data=${d.attributed.map((r) => ({
                    label: r.plugin ?? "—",
                    value: r.cost_usd,
                    detail: `${f.count(r.n)} requests`,
                  }))}
                  .format=${(v: number | null) => f.usd(v)}
                ></tl-bars>
              `
            : html`<tl-state empty emptyText="Nothing attributed yet"></tl-state>`}
        </jh-card>

        <jh-card
          header-title="Skill and agent invocations"
          header-subtitle="From transcripts — not redacted"
          padding="medium"
          show-header-divider
        >
          ${d.skillAgentInvocationsFromTranscripts.length
            ? html`
                <tl-table
                  .columns=${[
                    {
                      key: "skill",
                      label: "Skill",
                      render: (r: InvocationRow) =>
                        r.skill ? html`<span class="mono">${r.skill}</span>` : html`<span class="muted">—</span>`,
                    },
                    {
                      key: "agent",
                      label: "Agent",
                      render: (r: InvocationRow) =>
                        r.agent ? html`<span class="mono">${r.agent}</span>` : html`<span class="muted">—</span>`,
                    },
                    { key: "n", label: "Runs", align: "right" as const },
                  ] satisfies Column[]}
                  .rows=${d.skillAgentInvocationsFromTranscripts}
                ></tl-table>
              `
            : html`<tl-state empty emptyText="No invocations in the transcripts"></tl-state>`}
        </jh-card>
      </div>

      <jh-card
        header-title="Plugin loads"
        header-subtitle="plugin_id_hash is the only stable discriminator"
        padding="medium"
        show-header-divider
      >
        <p class="panel-note">
          ${unresolved > 0
            ? html`${unresolved} unmapped. <code>claude-local-telemetry alias derive</code> learns a
                name wherever OTel logged a hash for a request a transcript also named, and reports
                anything ambiguous rather than guessing. Copy prepares the command for one row.`
            : d.pluginHashes.length
              ? html`Every hash is named.`
              : html`No plugin hashes in the store. They arrive only from the OTLP sink — a
                  transcript names its plugin directly and never carries a hash, so there is
                  nothing here to map.`}
        </p>
        <tl-table .columns=${this.hashColumns()} .rows=${d.pluginHashes}></tl-table>
      </jh-card>
    `;
  }

  private hashColumns(): Column[] {
    return [
      {
        key: "plugin_name",
        label: "Reported name",
        render: (r: PluginHashRow) =>
          r.plugin_name === "third-party"
            ? html`<jh-tag size="small" label="third-party"></jh-tag>`
            : (r.plugin_name ?? "—"),
      },
      {
        key: "resolved",
        label: "Resolved",
        render: (r: PluginHashRow) =>
          r.resolved
            ? html`<strong>${r.resolved}</strong>`
            : html`<span class="muted">unmapped</span>`,
      },
      {
        key: "plugin_id_hash",
        label: "Hash",
        render: (r: PluginHashRow) =>
          html`<span class="mono" title=${r.plugin_id_hash ?? ""}
            >${f.shortId(r.plugin_id_hash, 12)}</span
          >`,
      },
      { key: "marketplace", label: "Marketplace" },
      {
        key: "cmd",
        label: "",
        sortable: false,
        render: (r: PluginHashRow) =>
          r.resolved || !r.plugin_id_hash
            ? nothing
            : html`<jh-button
                size="small"
                appearance="tertiary"
                label=${this.copied === r.plugin_id_hash ? "Copied" : "Copy alias cmd"}
                @click=${() => void this.copyAlias(r.plugin_id_hash as string)}
              ></jh-button>`,
      },
      {
        key: "skill_count",
        label: "Skills",
        align: "right",
        render: (r: PluginHashRow) => f.count(r.skill_count),
      },
      {
        key: "agent_count",
        label: "Agents",
        align: "right",
        render: (r: PluginHashRow) => f.count(r.agent_count),
      },
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "view-plugins": ViewPlugins;
  }
}
