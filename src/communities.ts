/**
 * Split a cluster by *purpose* rather than by time.
 *
 * Connected components answers "is there any path between these sessions". On a
 * graph where one repository is touched by several efforts, the answer is
 * always yes, so unrelated work on the same afternoon lands together. The quiet
 * split cuts on silence, which helps across days and does nothing within one.
 *
 * Community detection asks a different question: are these sessions more
 * densely connected to each other than to the rest of the graph? That is the
 * question that separates two efforts sharing a hub repository, and it is why
 * `session_edges` stores weights instead of only adjacency.
 *
 * Label propagation, not Louvain
 * ------------------------------
 * Label propagation (Raghavan, Albert, Kumara 2007) is near-linear, needs no
 * resolution parameter to tune, and is about forty lines. Louvain optimises
 * modularity more aggressively but brings a parameter whose right value is not
 * knowable from this data, and a wrong one merges or shatters communities with
 * equal confidence. Given the ledger already reports modularity, a simpler
 * method whose output can be *measured* beats a better method that has to be
 * trusted.
 *
 * The published algorithm is deliberately randomised -- ties break at random
 * and nodes are visited in random order -- which would make two runs over the
 * same store disagree. Both sources of randomness are replaced with a
 * deterministic order here: nodes are visited in session-id order and ties
 * break on the lexically smallest label. The cost is that a pathological graph
 * can oscillate rather than converge, so the iteration count is capped and the
 * result at the cap is used; the benefit is that a campaign id does not change
 * because the reconciler was re-run.
 */

export interface Edge {
  a: string;
  b: string;
  weight: number;
}

export interface CommunityResult {
  /** node -> community id */
  communityOf: Map<string, string>;
  modularity: number;
  iterations: number;
  converged: boolean;
}

/**
 * Newman-Girvan modularity of a partition on a weighted graph.
 *
 * Q ranges from -0.5 to 1. Above roughly 0.3 is usually taken as meaningful
 * structure; near 0 means the partition is no better than chance, which is the
 * honest reading for a graph that genuinely is one blob. Reported rather than
 * thresholded -- it says how much to trust the split, not whether to make it.
 */
export function modularity(
  nodes: Iterable<string>, edges: Edge[], communityOf: Map<string, string>,
): number {
  let m = 0;
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n, 0);
  for (const e of edges) {
    m += e.weight;
    degree.set(e.a, (degree.get(e.a) ?? 0) + e.weight);
    degree.set(e.b, (degree.get(e.b) ?? 0) + e.weight);
  }
  if (m === 0) return 0;

  // Sum over communities of (internal weight / m) - (total degree / 2m)^2.
  const internal = new Map<string, number>();
  const totalDeg = new Map<string, number>();
  for (const [node, deg] of degree) {
    const c = communityOf.get(node)!;
    totalDeg.set(c, (totalDeg.get(c) ?? 0) + deg);
  }
  for (const e of edges) {
    const ca = communityOf.get(e.a), cb = communityOf.get(e.b);
    if (ca === cb) internal.set(ca!, (internal.get(ca!) ?? 0) + e.weight);
  }

  let q = 0;
  for (const [c, deg] of totalDeg) {
    q += (internal.get(c) ?? 0) / m - Math.pow(deg / (2 * m), 2);
  }
  return q;
}

export function detect(
  nodes: string[], edges: Edge[], maxIterations = 100,
): CommunityResult {
  const adjacency = new Map<string, Array<{ to: string; w: number }>>();
  for (const n of nodes) adjacency.set(n, []);
  for (const e of edges) {
    adjacency.get(e.a)?.push({ to: e.b, w: e.weight });
    adjacency.get(e.b)?.push({ to: e.a, w: e.weight });
  }

  // Every node starts in its own community, then adopts whichever community its
  // neighbours point to most heavily. An isolated node keeps its own, which is
  // the right answer -- a session sharing no project with anything is its own
  // campaign, not a member of the nearest one.
  const label = new Map<string, string>();
  for (const n of nodes) label.set(n, n);

  const order = [...nodes].sort();          // deterministic sweep
  let iterations = 0, converged = false;

  for (; iterations < maxIterations; iterations++) {
    let changed = false;
    for (const n of order) {
      const neighbours = adjacency.get(n)!;
      if (!neighbours.length) continue;

      const score = new Map<string, number>();
      for (const { to, w } of neighbours) {
        const l = label.get(to)!;
        score.set(l, (score.get(l) ?? 0) + w);
      }
      // Heaviest neighbourhood label; ties break lexically so the sweep is
      // reproducible rather than dependent on Map insertion order.
      let best = label.get(n)!, bestScore = -Infinity;
      for (const [l, s] of [...score].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        if (s > bestScore) { best = l; bestScore = s; }
      }
      if (best !== label.get(n)) { label.set(n, best); changed = true; }
    }
    if (!changed) { converged = true; iterations++; break; }
  }

  return {
    communityOf: label,
    modularity: modularity(nodes, edges, label),
    iterations,
    converged,
  };
}
