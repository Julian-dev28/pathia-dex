/**
 * GET /api/venues?in=WETH&out=USDC
 *
 * The pool inventory behind a pair: every distinct pool the router would
 * consider, including the ones sitting in the middle of a two-hop route, and
 * how much of each token that pool actually holds.
 *
 * Inventory is read as ERC-20 balances of the pool contract rather than as
 * `getReserves`, deliberately. Reserves are a V2 concept; a V3 pool has no such
 * function, and a Solidly stable pool's reserves are not comparable to a
 * constant-product pool's. Token balances are the one measure that means the
 * same thing at every venue: this is the stock a trade can consume.
 */

import { NextResponse } from 'next/server';
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address } from 'viem';
import { bySymbol, UNIV3_FACTORY, MULTICALL3, type Token } from '@/lib/chain';
import { client, discover, type Venue, type Hop } from '@/lib/quote';
import { erc20Abi, univ3FactoryAbi, multicall3Abi } from '@/lib/abis';
import { jsonSafe } from '@/lib/format';
import { venueCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const ERC20 = parseAbi(erc20Abi);
const V3F = parseAbi(univ3FactoryAbi);
const MC3 = parseAbi(multicall3Abi);
const ZERO = '0x0000000000000000000000000000000000000000';

type Aggregate = readonly { success: boolean; returnData: `0x${string}` }[];

async function aggregate(
  calls: { target: Address; allowFailure: boolean; callData: `0x${string}` }[],
): Promise<Aggregate> {
  if (calls.length === 0) return [];
  const out: Aggregate[] = [];
  for (let i = 0; i < calls.length; i += 20) {
    out.push(
      (await client().readContract({
        address: MULTICALL3,
        abi: MC3,
        functionName: 'aggregate3',
        args: [calls.slice(i, i + 20)],
      })) as Aggregate,
    );
  }
  return out.flat();
}

/** One pool, as it appears in some route. */
type PoolRow = {
  family: Venue['family'];
  label: string;
  curve: string;
  tokenA: Token;
  tokenB: Token;
  pool: Address;
  inventoryA: bigint;
  inventoryB: bigint;
  usedByMultiHop: boolean;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inSym = url.searchParams.get('in') ?? 'WETH';
  const outSym = url.searchParams.get('out') ?? 'USDC';

  try {
    const tokenIn = bySymbol(inSym);
    const tokenOut = bySymbol(outSym);
    if (tokenIn.address === tokenOut.address) {
      return NextResponse.json({ error: 'tokenIn and tokenOut are the same' }, { status: 400 });
    }

    // Pool inventory moves slowly next to price, so this caches for far longer
    // than a quote does: the page is a directory, not a ticker.
    const { value } = await venueCache.get(`${tokenIn.symbol}:${tokenOut.symbol}`, async () => {
      const venues = await discover(tokenIn, tokenOut);

      // Flatten every venue into its hops. A hop is a pool; the same pool can
      // appear in several routes, so it is keyed and deduplicated.
      type Pending = {
        family: Venue['family'];
        label: string;
        curve: string;
        a: Token;
        b: Token;
        pool?: Address;
        fee?: number;
        multi: boolean;
      };
      const pending: Pending[] = [];

      for (const v of venues) {
        v.hops.forEach((h: Hop, i) => {
          const a = v.path[i];
          const b = v.path[i + 1];
          if (h.family === 'v3') {
            pending.push({
              family: 'v3',
              label: `Uniswap V3 ${(h.fee / 10_000).toFixed(2)}%`,
              curve: 'concentrated',
              a,
              b,
              fee: h.fee,
              multi: v.hops.length > 1,
            });
          } else if (h.family === 'v2') {
            pending.push({
              family: 'v2',
              label: v.label.split(' via ')[0],
              curve: 'constant product',
              a,
              b,
              pool: h.pool,
              multi: v.hops.length > 1,
            });
          } else {
            pending.push({
              family: 'aero',
              label: `Aerodrome ${h.stable ? 'sAMM' : 'vAMM'}`,
              curve: h.stable ? 'stable' : 'volatile',
              a,
              b,
              pool: h.pool,
              multi: v.hops.length > 1,
            });
          }
        });
      }

      // V3 hops carry a fee tier, not an address — quoting never needs one.
      // Displaying a pool does, so resolve them from the factory.
      const needsAddress = pending.filter((p) => !p.pool);
      const poolRes = await aggregate(
        needsAddress.map((p) => ({
          target: UNIV3_FACTORY as Address,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: V3F,
            functionName: 'getPool',
            args: [p.a.address, p.b.address, p.fee!],
          }),
        })),
      );
      needsAddress.forEach((p, i) => {
        const r = poolRes[i];
        if (!r?.success || r.returnData === '0x') return;
        try {
          const addr = decodeFunctionResult({
            abi: V3F,
            functionName: 'getPool',
            data: r.returnData,
          }) as Address;
          if (addr !== ZERO) p.pool = addr;
        } catch {
          /* absent */
        }
      });

      const unique = new Map<string, Pending>();
      for (const p of pending) {
        if (!p.pool) continue;
        const existing = unique.get(p.pool.toLowerCase());
        if (existing) {
          // A pool reached by both a direct and a multi-hop route is not
          // "multi-hop only"; the flag means "this pool is only reachable mid-route".
          existing.multi = existing.multi && p.multi;
          continue;
        }
        unique.set(p.pool.toLowerCase(), { ...p });
      }
      const rows = [...unique.values()];

      const balRes = await aggregate(
        rows.flatMap((r) =>
          [r.a.address, r.b.address].map((t) => ({
            target: t as Address,
            allowFailure: true,
            callData: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [r.pool!] }),
          })),
        ),
      );

      const decode = (i: number): bigint => {
        const res = balRes[i];
        if (!res?.success || res.returnData === '0x') return 0n;
        try {
          return decodeFunctionResult({
            abi: ERC20,
            functionName: 'balanceOf',
            data: res.returnData,
          }) as bigint;
        } catch {
          return 0n;
        }
      };

      const out: PoolRow[] = rows
        .map((r, i) => ({
          family: r.family,
          label: r.label,
          curve: r.curve,
          tokenA: r.a,
          tokenB: r.b,
          pool: r.pool!,
          inventoryA: decode(i * 2),
          inventoryB: decode(i * 2 + 1),
          usedByMultiHop: r.multi,
        }))
        .filter((r) => r.inventoryA > 0n || r.inventoryB > 0n);

      return jsonSafe({
        tokenIn,
        tokenOut,
        routesConsidered: venues.length,
        multiHopRoutes: venues.filter((v) => v.hops.length > 1).length,
        pools: out,
      });
    });

    return NextResponse.json(value as object, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'venue lookup failed' },
      { status: 500 },
    );
  }
}
