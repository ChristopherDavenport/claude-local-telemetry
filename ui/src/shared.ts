/**
 * CSS fragments shared across components.
 *
 * Each component has its own shadow root, so there is no cascade between them;
 * reuse has to be explicit. These are the pieces that would otherwise drift —
 * table chrome above all, since six views render one.
 */

import { css } from "lit";

export const panel = css`
  .panel-title {
    margin: 0 0 var(--jh-size-300);
    font-size: var(--jh-font-size-500);
    line-height: var(--jh-font-line-height-700);
    font-weight: 500;
    color: var(--jh-color-content-primary-enabled);
  }

  .panel-note {
    margin: 0 0 var(--jh-size-300);
    font-size: var(--jh-font-size-300);
    line-height: var(--jh-font-line-height-500);
    color: var(--jh-color-content-secondary-enabled);
  }

  /* Inline text utilities. Repeated in the table fragment because a shadow root
   * gets only the fragments its component imports, and several views use these
   * outside a table. */
  .mono {
    font-family: var(--jh-font-family-mono);
    font-size: var(--jh-font-size-300);
  }

  .muted {
    color: var(--jh-color-content-secondary-enabled);
  }

  code {
    font-family: var(--jh-font-family-mono);
    font-size: var(--jh-font-size-300);
    background: var(--jh-color-container-secondary-enabled);
    border-radius: var(--jh-border-radius-50);
    padding: 1px 4px;
  }
`;

export const table = css`
  .scroll {
    overflow-x: auto;
    /* A scroll container is only reachable by keyboard if it can take focus. */
    scrollbar-gutter: stable;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--jh-font-size-350);
    line-height: var(--jh-font-line-height-500);
  }

  caption {
    text-align: left;
    padding-bottom: var(--jh-size-200);
    font-size: var(--jh-font-size-300);
    color: var(--jh-color-content-secondary-enabled);
  }

  th {
    text-align: left;
    font-weight: 500;
    white-space: nowrap;
    color: var(--jh-color-content-secondary-enabled);
    border-bottom: 1px solid var(--jh-color-divider-primary);
    padding: var(--jh-size-200) var(--jh-size-300);
    /* Long tables are scanned against their headers, not scrolled back to. */
    position: sticky;
    top: 0;
    background: var(--jh-color-container-primary-enabled);
    z-index: 1;
  }

  td {
    padding: var(--jh-size-200) var(--jh-size-300);
    border-bottom: 1px solid var(--jh-color-divider-secondary);
    vertical-align: top;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  tbody tr.clickable {
    cursor: pointer;
  }

  tbody tr.clickable:hover td {
    background: var(--jh-color-container-secondary-hover);
  }

  /* Numbers are compared down a column, so they are right-aligned and lining.
   * Proportional digits make a column of figures ragged and unscannable. */
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--jh-font-family-mono);
    font-size: var(--jh-font-size-300);
  }

  .muted {
    color: var(--jh-color-content-secondary-enabled);
  }

  .negative {
    color: var(--jh-color-content-negative-enabled);
  }

  .positive {
    color: var(--jh-color-content-positive-enabled);
  }

  th button {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--jh-size-100);
  }

  th button:focus-visible {
    outline: 2px solid var(--jh-color-interactive-focus-outer);
    outline-offset: 2px;
  }

  .sort-arrow {
    font-size: var(--jh-font-size-250);
    color: var(--jh-color-content-brand-enabled);
  }
`;

export const toolbar = css`
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--jh-size-300);
    margin-bottom: var(--tl-gap);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--jh-size-100);
    min-width: 0;
  }

  .field > label {
    font-size: var(--jh-font-size-300);
    font-weight: 500;
    color: var(--jh-color-content-secondary-enabled);
  }

  /* jh-ui has no select or native-input primitive, so these are styled from
   * tokens to sit alongside jh-button and jh-input without looking foreign. */
  select,
  input[type="text"] {
    font: inherit;
    font-size: var(--jh-font-size-350);
    color: var(--jh-color-content-primary-enabled);
    background: var(--jh-color-container-primary-enabled);
    border: 1px solid var(--jh-color-divider-primary);
    border-radius: var(--jh-border-radius-100);
    padding: var(--jh-size-200) var(--jh-size-250);
    min-height: 36px;
  }

  select:focus-visible,
  input[type="text"]:focus-visible {
    outline: 2px solid var(--jh-color-interactive-focus-outer);
    outline-offset: 1px;
  }

  input[type="text"] {
    min-width: 220px;
  }
`;

/** Wraps a chart so the SVG scales and the caption sits with it. */
export const figure = css`
  figure {
    margin: 0;
  }

  figcaption {
    margin-top: var(--jh-size-200);
    font-size: var(--jh-font-size-300);
    color: var(--jh-color-content-secondary-enabled);
  }

  svg {
    display: block;
    width: 100%;
    overflow: visible;
  }

  .grid line {
    stroke: var(--tl-grid);
    stroke-width: 1;
  }

  .axis text {
    fill: var(--tl-axis-ink);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--jh-size-300);
    margin-bottom: var(--jh-size-300);
    font-size: var(--jh-font-size-300);
    color: var(--jh-color-content-secondary-enabled);
  }

  .legend span {
    display: inline-flex;
    align-items: center;
    gap: var(--jh-size-150);
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex: none;
  }
`;

/** Utility layout helpers used by several views. */
export const layout = css`
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tl-gap);
  }

  .grid-2 {
    display: grid;
    gap: var(--tl-gap);
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    /* Cards size to their content. Stretching a three-bar chart to match the
     * height of a 25-row table next to it reads as missing data. */
    align-items: start;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--tl-gap);
  }

  .spacer {
    flex: 1 1 auto;
  }
`;
