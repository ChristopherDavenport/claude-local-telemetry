/**
 * Base class for views that fetch.
 *
 * Every view does the same four things — fetch on connect, refetch when a
 * filter changes, abort the in-flight request, and render one of loading /
 * error / data. Doing that by hand in eight files is how a stale response
 * eventually overwrites a fresh one.
 *
 * The abort is the part that matters. Changing the range twice quickly fires
 * two requests, and without cancellation the slower one can land last and
 * repaint the chart with the range the reader already moved off.
 */

import { LitElement } from "lit";
import { state } from "lit/decorators.js";

export abstract class TlView<T> extends LitElement {
  @state() protected data: T | null = null;
  @state() protected error: Error | null = null;
  @state() protected loading = false;

  private controller: AbortController | null = null;

  protected abstract fetchData(signal: AbortSignal): Promise<T>;

  override connectedCallback() {
    super.connectedCallback();
    void this.reload();
  }

  override disconnectedCallback() {
    this.controller?.abort();
    this.controller = null;
    super.disconnectedCallback();
  }

  protected async reload(): Promise<void> {
    this.controller?.abort();
    const ctrl = new AbortController();
    this.controller = ctrl;

    this.loading = true;
    this.error = null;
    try {
      const data = await this.fetchData(ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.data = data;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      this.error = err as Error;
      this.data = null;
    } finally {
      // A superseded request must not clear the spinner belonging to the one
      // that replaced it.
      if (this.controller === ctrl) {
        this.loading = false;
        this.controller = null;
      }
    }
  }
}
