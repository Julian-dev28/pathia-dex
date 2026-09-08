/**
 * The router core.
 *
 * Everything here answers one question: for a given pair, how much output does
 * each venue give at each size, and what is the best way to cut a trade across
 * them. There is no aggregator API in this file. Prices come from pool state
 * and from quoter contracts, read over public RPC.
 *
 * The central object is a *ladder*: every venue quoted at a geometric series of
 * sizes in a single batched call. One ladder feeds three products — the best
 * single venue, the optimal split, and the depth curve — so the expensive part
 * (the network round trip) happens once.
 */

import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import {
  RPC_URLS,
  MULTICALL3,
  UNIV3_QUOTER,
  UNIV3_FEE_TIERS,
  V2_VENUES,
  AERO_FACTORY,
  type Token,
} from './chain';
import {
  multicall3Abi,
  v2FactoryAbi,
  v2PairAbi,
  aeroFactoryAbi,
  aeroPoolAbi,
  quoterV2Abi,
} from './abis';

const MC3 = parseAbi(multicall3Abi);
const V2F = parseAbi(v2FactoryAbi);
const V2P = parseAbi(v2PairAbi);
const AEROF = parseAbi(aeroFactoryAbi);
const AEROP = parseAbi(aeroPoolAbi);
const QUOTER = parseAbi(quoterV2Abi);

const ZERO = '0x0000000000000000000000000000000000000000';

/** A place a trade can be routed through. Discovered, not configured. */
export type Venue =
  | { kind: 'v3'; id: string; label: string; fee: number }
  | { kind: 'v2'; id: string; label: string; pool: Address; router: Address; feeBps: number }
  | { kind: 'aero'; id: string; label: string; pool: Address; stable: boolean };

export type Call = { target: Address; allowFailure: boolean; callData: `0x${string}` };

let cached: PublicClient | null = null;

/**
 * Public RPC endpoints rate-limit and occasionally return stale state, so the
 * transport is a fallback chain rather than one URL. `batch` lets viem coalesce
 * concurrent eth_calls into a single JSON-RPC array, which matters because the
 * depth page fires several ladders at once.
 */
export function client(): PublicClient {
  if (!cached) {
    cached = createPublicClient({
      chain: base,
      transport: fallback(
        RPC_URLS.map((url) => http(url, { batch: true, retryCount: 2, timeout: 12_000 })),
      ),
    }) as PublicClient;
  }
  return cached;
}

/**
 * One aggregate3 round trip. Failures come back as flags, not thrown errors.
 *
 * `blockNumber` pins the read to a specific height. The app never uses it —
 * traders want the current price — but the fork tests do: a prediction made at
 * `latest` and replayed against a fork two blocks later is comparing two
 * different markets, and the discrepancy would be blamed on the maths.
 */
async function batch(
  calls: Call[],
  blockNumber?: bigint,
): Promise<readonly { success: boolean; returnData: `0x${string}` }[]> {
  if (calls.length === 0) return [];
  const c = client();

  // Chunked, because a batch is not free of the node's eth_call gas cap. A
  // V3 quote through a thin pool walks every initialised tick it crosses and
  // can cost several million gas on its own; forty-eight of those in one
  // aggregate3 exceeds the cap and the endpoint rejects the whole call rather
  // than the expensive part of it. Discovered on WETH/DAI, where the shallow
  // tiers are the expensive ones.
  const CHUNK = 12;
  const chunks: Call[][] = [];
  for (let i = 0; i < calls.length; i += CHUNK) chunks.push(calls.slice(i, i + CHUNK));

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        return (await c.readContract({
          address: MULTICALL3,
          abi: MC3,
          functionName: 'aggregate3',
          args: [chunk],
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        })) as readonly { success: boolean; returnData: `0x${string}` }[];
      } catch {
        // One over-budget chunk must not take the other venues down with it.
        return chunk.map(() => ({ success: false, returnData: '0x' as `0x${string}` }));
      }
    }),
  );

  return results.flat();
}

/**
 * Ask every factory whether it has a pool for this pair.
 *
 * Uniswap V3 is the exception: its quoter takes a fee tier directly and reverts
 * when the pool is absent, so a discovery hop for it would be a wasted round
 * trip. We list all four tiers and let the quote stage prune the dead ones.
 */
export async function discover(
  tokenIn: Token,
  tokenOut: Token,
  blockNumber?: bigint,
): Promise<Venue[]> {
  const calls: Call[] = [];

  for (const v of V2_VENUES) {
    calls.push({
      target: v.factory,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: V2F,
        functionName: 'getPair',
        args: [tokenIn.address, tokenOut.address],
      }),
    });
  }
  for (const stable of [true, false]) {
    calls.push({
      target: AERO_FACTORY,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: AEROF,
        functionName: 'getPool',
        args: [tokenIn.address, tokenOut.address, stable],
      }),
    });
  }

  const res = await batch(calls, blockNumber);
  const venues: Venue[] = [];

  V2_VENUES.forEach((v, i) => {
    const r = res[i];
    if (!r?.success) return;
    const pool = decodeFunctionResult({ abi: V2F, functionName: 'getPair', data: r.returnData }) as Address;
    if (pool === ZERO) return;
    // Token ordering is resolved in the quote stage by reading token0() from
    // the pair: sort order is fixed by the contract, not by argument order,
    // and assuming it inverts the price.
    venues.push({
      kind: 'v2',
      id: `v2:${v.name}`,
      label: v.name,
      pool,
      router: v.router,
      feeBps: v.feeBps,
    });
  });

  [true, false].forEach((stable, j) => {
    const r = res[V2_VENUES.length + j];
    if (!r?.success) return;
    const pool = decodeFunctionResult({ abi: AEROF, functionName: 'getPool', data: r.returnData }) as Address;
    if (pool === ZERO) return;
    venues.push({
      kind: 'aero',
      id: `aero:${stable ? 'stable' : 'volatile'}`,
      label: `Aerodrome ${stable ? 'sAMM' : 'vAMM'}`,
      pool,
      stable,
    });
  });

  for (const fee of UNIV3_FEE_TIERS) {
    venues.push({
      kind: 'v3',
      id: `v3:${fee}`,
      label: `Uniswap V3 ${(fee / 10_000).toFixed(2)}%`,
      fee,
    });
  }

  return venues;
}

/** Reserve snapshot for a constant-product pool, oriented to the trade. */
type V2State = { reserveIn: bigint; reserveOut: bigint; feeBps: number };

/**
 * Constant product, done by hand rather than by calling the router's
 * getAmountsOut. Two reasons: it costs no RPC (so a 12-rung ladder is free once
 * reserves are known), and the fee numerator differs per fork — BaseSwap takes
 * 25bp where Uniswap takes 30 — which a shared router helper silently gets
 * wrong.
 *
 *   out = (in * (10000 - fee) * reserveOut) / (reserveIn * 10000 + in * (10000 - fee))
 *
 * All bigint. A float here is a rounding error denominated in money.
 */
export function v2AmountOut(amountIn: bigint, s: V2State): bigint {
  if (amountIn <= 0n || s.reserveIn <= 0n || s.reserveOut <= 0n) return 0n;
  const inAfterFee = amountIn * BigInt(10_000 - s.feeBps);
  const numerator = inAfterFee * s.reserveOut;
  const denominator = s.reserveIn * 10_000n + inAfterFee;
  return numerator / denominator;
}

export type Rung = { amountIn: bigint; amountOut: bigint };
export type VenueCurve = {
  venue: Venue;
  rungs: Rung[];
  /** Gas the quoter reports for this venue, used for net-of-cost comparison. */
  gasEstimate: bigint;
};

/**
 * Geometric size ladder ending at the requested amount.
 *
 * Geometric rather than linear because price impact is roughly linear in size
 * for small trades and blows up at the top — linear spacing spends most of its
 * samples in the flat region where nothing interesting happens.
 */
export function ladder(amountIn: bigint, rungs = 12): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < rungs; i++) {
    // fraction = 2^(i - (rungs-1)), i.e. the top rung is the full amount and
    // each step down halves it.
    const shift = BigInt(rungs - 1 - i);
    const v = amountIn / (1n << shift);
    if (v > 0n && (out.length === 0 || v > out[out.length - 1])) out.push(v);
  }
  return out;
}

/**
 * Quote every venue at every rung in one batch.
 *
 * V2 pools need only their reserves — one call each, then the whole curve is
 * arithmetic. Aerodrome and Uniswap V3 need a contract call per rung, because
 * a Solidly stable curve and a concentrated-liquidity tick walk cannot be
 * reproduced off-chain without reimplementing the pool, and a reimplementation
 * that drifts by a tick is worse than useless.
 */
export async function quoteLadder(
  tokenIn: Token,
  tokenOut: Token,
  sizes: bigint[],
  venues?: Venue[],
  blockNumber?: bigint,
): Promise<VenueCurve[]> {
  const vs = venues ?? (await discover(tokenIn, tokenOut, blockNumber));

  // Stage 1: V2 reserves and token ordering.
  const v2s = vs.filter((v): v is Extract<Venue, { kind: 'v2' }> => v.kind === 'v2');
  const stage1: Call[] = [];
  for (const v of v2s) {
    stage1.push({
      target: v.pool,
      allowFailure: true,
      callData: encodeFunctionData({ abi: V2P, functionName: 'getReserves' }),
    });
    stage1.push({
      target: v.pool,
      allowFailure: true,
      callData: encodeFunctionData({ abi: V2P, functionName: 'token0' }),
    });
  }
  const r1 = await batch(stage1, blockNumber);

  const v2State = new Map<string, V2State>();
  v2s.forEach((v, i) => {
    const resv = r1[i * 2];
    const tok0 = r1[i * 2 + 1];
    if (!resv?.success || !tok0?.success) return;
    const [r0, r1v] = decodeFunctionResult({
      abi: V2P,
      functionName: 'getReserves',
      data: resv.returnData,
    }) as unknown as [bigint, bigint, number];
    const token0 = (
      decodeFunctionResult({ abi: V2P, functionName: 'token0', data: tok0.returnData }) as Address
    ).toLowerCase();
    const inIsToken0 = token0 === tokenIn.address.toLowerCase();
    v2State.set(v.id, {
      reserveIn: inIsToken0 ? r0 : r1v,
      reserveOut: inIsToken0 ? r1v : r0,
      feeBps: v.feeBps,
    });
  });

  // Stage 2: one on-chain quote per (contract venue, rung).
  const stage2: Call[] = [];
  const index: { venueId: string; size: bigint }[] = [];
  for (const v of vs) {
    if (v.kind === 'v2') continue;
    for (const size of sizes) {
      if (v.kind === 'aero') {
        stage2.push({
          target: v.pool,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: AEROP,
            functionName: 'getAmountOut',
            args: [size, tokenIn.address],
          }),
        });
      } else {
        stage2.push({
          target: UNIV3_QUOTER,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: QUOTER,
            functionName: 'quoteExactInputSingle',
            args: [
              {
                tokenIn: tokenIn.address,
                tokenOut: tokenOut.address,
                amountIn: size,
                fee: v.fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          }),
        });
      }
      index.push({ venueId: v.id, size });
    }
  }
  const r2 = await batch(stage2, blockNumber);

  const contractRungs = new Map<string, Rung[]>();
  const gasByVenue = new Map<string, bigint>();
  index.forEach((entry, i) => {
    const r = r2[i];
    if (!r?.success || r.returnData === '0x') return;
    const v = vs.find((x) => x.id === entry.venueId)!;
    let amountOut = 0n;
    try {
      if (v.kind === 'aero') {
        amountOut = decodeFunctionResult({
          abi: AEROP,
          functionName: 'getAmountOut',
          data: r.returnData,
        }) as bigint;
      } else {
        const decoded = decodeFunctionResult({
          abi: QUOTER,
          functionName: 'quoteExactInputSingle',
          data: r.returnData,
        }) as unknown as [bigint, bigint, number, bigint];
        amountOut = decoded[0];
        gasByVenue.set(entry.venueId, decoded[3]);
      }
    } catch {
      return; // pool absent for this tier, or quoter reverted at this size
    }
    if (amountOut <= 0n) return;
    const list = contractRungs.get(entry.venueId) ?? [];
    list.push({ amountIn: entry.size, amountOut });
    contractRungs.set(entry.venueId, list);
  });

  const curves: VenueCurve[] = [];
  for (const v of vs) {
    if (v.kind === 'v2') {
      const s = v2State.get(v.id);
      if (!s) continue;
      const rungs = sizes.map((amountIn) => ({ amountIn, amountOut: v2AmountOut(amountIn, s) }));
      if (rungs.every((r) => r.amountOut === 0n)) continue;
      // Measured at 102,197 gas against the deployed Uniswap V2 router on a
      // mainnet fork, not guessed: contracts/test/GasProfile.t.sol asserts it
      // and fails if it drifts.
      curves.push({ venue: v, rungs, gasEstimate: 102_000n });
    } else {
      const rungs = contractRungs.get(v.id);
      if (!rungs || rungs.length === 0) continue;
      rungs.sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1));
      curves.push({
        venue: v,
        rungs,
        // Aerodrome measured at 180,947 on the same fork. The V3 fallback only
        // applies if the quoter declined to report, which it rarely does; its
        // real cost varies with the ticks a trade crosses, so V3 uses the
        // quoter's per-quote estimate above rather than any constant.
        gasEstimate: gasByVenue.get(v.id) ?? (v.kind === 'aero' ? 181_000n : 130_000n),
      });
    }
  }

  return curves;
}

/**
 * Output of a venue at an arbitrary size, interpolated from its sampled curve.
 *
 * Piecewise-linear on a concave, monotone function underestimates between
 * samples, which is the safe direction: the splitter will never believe a venue
 * is deeper than it is. Above the top rung we extrapolate at the marginal rate
 * of the last segment, again an underestimate once impact is accounted for.
 */
export function interpolate(curve: VenueCurve, amountIn: bigint): bigint {
  const r = curve.rungs;
  if (r.length === 0 || amountIn <= 0n) return 0n;
  if (amountIn <= r[0].amountIn) {
    return (r[0].amountOut * amountIn) / r[0].amountIn;
  }
  for (let i = 1; i < r.length; i++) {
    if (amountIn <= r[i].amountIn) {
      const dIn = r[i].amountIn - r[i - 1].amountIn;
      const dOut = r[i].amountOut - r[i - 1].amountOut;
      if (dIn === 0n) return r[i].amountOut;
      return r[i - 1].amountOut + (dOut * (amountIn - r[i - 1].amountIn)) / dIn;
    }
  }
  const last = r[r.length - 1];
  const prev = r.length > 1 ? r[r.length - 2] : { amountIn: 0n, amountOut: 0n };
  const dIn = last.amountIn - prev.amountIn;
  const dOut = last.amountOut - prev.amountOut;
  if (dIn <= 0n) return last.amountOut;
  return last.amountOut + (dOut * (amountIn - last.amountIn)) / dIn;
}

export type Allocation = { venue: Venue; amountIn: bigint; amountOut: bigint; share: number };
export type Route = {
  allocations: Allocation[];
  amountIn: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
};

/**
 * Split a trade across venues by greedy marginal allocation.
 *
 * Each pool's output curve is concave in size — the second unit always buys
 * less than the first — so handing the next slice to whichever venue offers the
 * best marginal rate converges on the optimum, which is the same argument that
 * makes water-filling optimal. Slices are what makes it approximate; 32 of them
 * puts the residual well inside a basis point on every pair measured so far.
 *
 * Splitting is not free: each extra venue is another pool touched, so a slice
 * only moves if it beats staying put by more than its share of that gas. That
 * check is applied in `bestRoute`, where the gas price is known.
 */
export function splitRoute(curves: VenueCurve[], amountIn: bigint, slices = 32): Route {
  if (curves.length === 0 || amountIn <= 0n) {
    return { allocations: [], amountIn, amountOut: 0n, gasEstimate: 0n };
  }

  const alloc = new Map<string, bigint>(curves.map((c) => [c.venue.id, 0n]));
  const slice = amountIn / BigInt(slices);
  let remaining = amountIn;

  for (let i = 0; i < slices && remaining > 0n; i++) {
    const step = i === slices - 1 ? remaining : slice;
    if (step <= 0n) break;

    let bestId: string | null = null;
    let bestGain = 0n;
    for (const c of curves) {
      const cur = alloc.get(c.venue.id)!;
      const gain = interpolate(c, cur + step) - interpolate(c, cur);
      if (gain > bestGain) {
        bestGain = gain;
        bestId = c.venue.id;
      }
    }
    if (!bestId) break;
    alloc.set(bestId, alloc.get(bestId)! + step);
    remaining -= step;
  }

  const allocations: Allocation[] = [];
  let total = 0n;
  let gas = 0n;
  for (const c of curves) {
    const a = alloc.get(c.venue.id)!;
    if (a <= 0n) continue;
    const out = interpolate(c, a);
    total += out;
    gas += c.gasEstimate;
    allocations.push({
      venue: c.venue,
      amountIn: a,
      amountOut: out,
      share: Number((a * 10_000n) / amountIn) / 100,
    });
  }
  allocations.sort((x, y) => (x.amountIn > y.amountIn ? -1 : 1));

  return { allocations, amountIn, amountOut: total, gasEstimate: gas };
}

/** Minimum net advantage, in basis points, before a split is recommended. */
export const MIN_SPLIT_EDGE_BPS = 1n;

export type BestRoute = {
  single: Route;
  split: Route;
  chosen: 'single' | 'split';
  /** Split advantage over the best single venue, in basis points, before gas. */
  edgeBps: number;
  /** The same advantage after subtracting the extra gas, in output token units. */
  netEdgeBps: number;
};

/**
 * Compare the best single venue against the split, and price the difference.
 *
 * A split that wins by 3bp on a trade whose extra pool hop costs 6bp of gas is
 * a loss, and quoting it as a win is the most common way an aggregator
 * flatters itself. `gasCostInOutputToken` is what makes the comparison honest;
 * the caller supplies it because only the caller knows the gas price and the
 * output token's price in ETH.
 */
export function bestRoute(
  curves: VenueCurve[],
  amountIn: bigint,
  gasCostInOutputToken: bigint = 0n,
): BestRoute {
  let single: Route = { allocations: [], amountIn, amountOut: 0n, gasEstimate: 0n };
  for (const c of curves) {
    const out = interpolate(c, amountIn);
    if (out > single.amountOut) {
      single = {
        allocations: [{ venue: c.venue, amountIn, amountOut: out, share: 100 }],
        amountIn,
        amountOut: out,
        gasEstimate: c.gasEstimate,
      };
    }
  }

  const split = splitRoute(curves, amountIn);

  const edgeBps =
    single.amountOut > 0n
      ? Number(((split.amountOut - single.amountOut) * 10_000n) / single.amountOut)
      : 0;

  // Extra hops beyond the first are what the split actually costs.
  const extraHops = BigInt(Math.max(0, split.allocations.length - 1));
  const extraGasCost = extraHops * gasCostInOutputToken;
  const netSplit = split.amountOut - extraGasCost;
  const netEdgeBps =
    single.amountOut > 0n ? Number(((netSplit - single.amountOut) * 10_000n) / single.amountOut) : 0;

  // A split has to be worth doing, not merely arithmetically ahead. Beating
  // the single venue by a fraction of a basis point buys the user nothing and
  // costs them an extra pool's worth of execution risk and a second failure
  // mode, so the recommendation needs a full basis point of daylight before it
  // changes. Below that the honest answer is "route it to one venue".
  const threshold = single.amountOut + (single.amountOut * MIN_SPLIT_EDGE_BPS) / 10_000n;

  return {
    single,
    split,
    chosen: netSplit > threshold ? 'split' : 'single',
    edgeBps,
    netEdgeBps,
  };
}
