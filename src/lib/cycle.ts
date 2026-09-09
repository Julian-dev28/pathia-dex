/**
 * Triangular arbitrage by negative-cycle detection.
 *
 * The two-venue round trip in `arb.ts` asks whether one pair disagrees with
 * itself. This asks a bigger question: does any *loop* of tokens return more
 * than it started with — WETH to USDC to cbBTC and back — regardless of how
 * many hops it takes to get there.
 *
 * The classic formulation. Build a directed graph whose nodes are tokens and
 * whose edges carry the best exchange rate between them. An arbitrage loop is a
 * cycle whose rates multiply to more than one:
 *
 *     r₁ · r₂ · … · rₙ > 1
 *
 * Take logarithms and that becomes a sum, and negate it so the interesting case
 * is negative:
 *
 *     −log r₁ − log r₂ − … − log rₙ < 0
 *
 * which is exactly a negative cycle, and Bellman-Ford finds those. The
 * transformation is the whole trick: a multiplicative search over paths becomes
 * an additive one, and an additive one has a textbook algorithm.
 *
 * Gas is folded into the edge weights rather than subtracted at the end. A loop
 * that clears 3bp gross across four hops is not a smaller win than one that
 * clears 3bp across two — it is usually a loss, and only a per-edge cost makes
 * the search prefer the shorter loop on its own.
 *
 * What this will report, almost always, is nothing. Loops like these are
 * contested by searchers running colocated infrastructure and close inside a
 * block. Finding none is the honest result of a correct search, not a broken
 * one.
 */

import type { Token } from './chain';

export type RateEdge = {
  from: Token;
  to: Token;
  /** Output per unit of input, decimal-normalised. */
  rate: number;
  venue: string;
  hops: number;
  /** Cost of traversing this edge, as a fraction of notional. */
  gasFraction: number;
};

export type Cycle = {
  path: Token[];
  edges: RateEdge[];
  /** Product of the rates. Above 1 is a gross profit. */
  grossMultiple: number;
  grossBps: number;
  /** After the per-edge gas charge. */
  netMultiple: number;
  netBps: number;
  profitable: boolean;
};

const EPSILON = 1e-12;

/**
 * Find the most profitable arbitrage loop, if any.
 *
 * Bellman-Ford relaxes every edge |V|−1 times; an edge that still improves on
 * the next pass is inside a negative cycle. Walking predecessors |V| times from
 * that edge lands inside the cycle rather than on its tail, which is the detail
 * that makes the extracted loop an actual loop.
 */
export function findCycle(tokens: Token[], edges: RateEdge[]): Cycle | null {
  if (tokens.length < 2 || edges.length === 0) return null;

  const index = new Map(tokens.map((t, i) => [t.address.toLowerCase(), i]));
  const n = tokens.length;

  // Weight combines the rate and the cost of using the edge. An edge is only
  // worth taking if it beats its own gas.
  const weight = (e: RateEdge): number => {
    const effective = e.rate * (1 - e.gasFraction);
    if (!(effective > 0) || !Number.isFinite(effective)) return Number.POSITIVE_INFINITY;
    return -Math.log(effective);
  };

  const usable = edges.filter((e) => Number.isFinite(weight(e)));
  if (usable.length === 0) return null;

  // Every node starts at zero rather than seeding a single source: a negative
  // cycle can sit in a component no chosen source reaches, and starting
  // everywhere costs nothing and finds all of them.
  const dist = new Array<number>(n).fill(0);
  const pred = new Array<number>(n).fill(-1);
  const predEdge = new Array<RateEdge | null>(n).fill(null);

  let touched = -1;
  for (let pass = 0; pass < n; pass++) {
    touched = -1;
    for (const e of usable) {
      const u = index.get(e.from.address.toLowerCase());
      const v = index.get(e.to.address.toLowerCase());
      if (u === undefined || v === undefined) continue;
      const w = weight(e);
      if (dist[u] + w < dist[v] - EPSILON) {
        dist[v] = dist[u] + w;
        pred[v] = u;
        predEdge[v] = e;
        touched = v;
      }
    }
    if (touched === -1) break; // settled, so there is no negative cycle
  }

  if (touched === -1) return null;

  // Walk back n times to be certain of landing inside the cycle, not on the
  // path that leads into it.
  let cursor = touched;
  for (let i = 0; i < n; i++) cursor = pred[cursor] === -1 ? cursor : pred[cursor];

  const loop: number[] = [];
  let walker = cursor;
  do {
    loop.push(walker);
    walker = pred[walker];
    if (walker === -1) return null;
  } while (walker !== cursor && loop.length <= n);

  if (loop.length < 2) return null;
  loop.push(cursor);
  loop.reverse();

  const cycleEdges: RateEdge[] = [];
  for (let i = 1; i < loop.length; i++) {
    const e = predEdge[loop[i]];
    if (!e) return null;
    cycleEdges.push(e);
  }

  let gross = 1;
  let net = 1;
  for (const e of cycleEdges) {
    gross *= e.rate;
    net *= e.rate * (1 - e.gasFraction);
  }

  return {
    path: loop.map((i) => tokens[i]),
    edges: cycleEdges,
    grossMultiple: gross,
    grossBps: (gross - 1) * 10_000,
    netMultiple: net,
    netBps: (net - 1) * 10_000,
    profitable: net > 1,
  };
}

/**
 * Every simple loop of three tokens, scored.
 *
 * Bellman-Ford answers "is there a profitable loop" and returns one. A trader
 * looking at a market also wants to see the near misses — which triangles are
 * close to opening, and by how much — so this enumerates triangles directly and
 * ranks them. Three is the practical limit: the count grows as the cube of the
 * token list and longer loops pay more gas than the edge they capture.
 */
export function rankTriangles(tokens: Token[], edges: RateEdge[], limit = 8): Cycle[] {
  const byPair = new Map<string, RateEdge>();
  for (const e of edges) {
    const key = `${e.from.symbol}>${e.to.symbol}`;
    const existing = byPair.get(key);
    // Best rate wins where several venues quote the same direction.
    if (!existing || e.rate > existing.rate) byPair.set(key, e);
  }

  const out: Cycle[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      for (let k = 0; k < tokens.length; k++) {
        if (i === j || j === k || i === k) continue;
        // Each triangle has three rotations and they are the same loop; keep
        // the one that starts at the lowest index.
        if (i > j || i > k) continue;

        const a = byPair.get(`${tokens[i].symbol}>${tokens[j].symbol}`);
        const b = byPair.get(`${tokens[j].symbol}>${tokens[k].symbol}`);
        const c = byPair.get(`${tokens[k].symbol}>${tokens[i].symbol}`);
        if (!a || !b || !c) continue;

        const legs = [a, b, c];
        let gross = 1;
        let net = 1;
        for (const e of legs) {
          gross *= e.rate;
          net *= e.rate * (1 - e.gasFraction);
        }
        if (!Number.isFinite(gross) || gross <= 0) continue;

        out.push({
          path: [tokens[i], tokens[j], tokens[k], tokens[i]],
          edges: legs,
          grossMultiple: gross,
          grossBps: (gross - 1) * 10_000,
          netMultiple: net,
          netBps: (net - 1) * 10_000,
          profitable: net > 1,
        });
      }
    }
  }

  return out.sort((x, y) => y.netBps - x.netBps).slice(0, limit);
}
