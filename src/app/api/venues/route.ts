/**
 * GET /api/venues?in=WETH&out=USDC
 *
 * The pool inventory behind a pair: every venue that has a market, its pool
 * address, and how much of each token that pool actually holds.
 *
 * Inventory is read as ERC-20 balances of the pool contract rather than as
 * `getReserves`, deliberately. Reserves are a V2 concept; a V3 pool has no such
 * function, and a Solidly stable pool's reserves are not comparable to a
 * constant-product pool's. Token balances are the one measure that means the
 * same thing at every venue: this is the stock a trade can consume.
 */

import { NextResponse } from 'next/server';
import { encodeFunctionData, decodeFunctionResult, parseAbi, type Address } from 'viem';
import { bySymbol, UNIV3_FACTORY, UNIV3_FEE_TIERS, MULTICALL3 } from '@/lib/chain';
import { client, discover, type Venue } from '@/lib/quote';
import { erc20Abi, univ3FactoryAbi, multicall3Abi } from '@/lib/abis';
import { jsonSafe } from '@/lib/format';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const ERC20 = parseAbi(erc20Abi);
const V3F = parseAbi(univ3FactoryAbi);
const MC3 = parseAbi(multicall3Abi);
const ZERO = '0x0000000000000000000000000000000000000000';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inSym = url.searchParams.get('in') ?? 'WETH';
  const outSym = url.searchParams.get('out') ?? 'USDC';

  try {
    const tokenIn = bySymbol(inSym);
    const tokenOut = bySymbol(outSym);
    const c = client();

    const venues = await discover(tokenIn, tokenOut);

    // V3 venues are listed by fee tier without an address, because quoting does
    // not need one. Displaying a pool does, so resolve them here.
    const v3 = venues.filter((v): v is Extract<Venue, { kind: 'v3' }> => v.kind === 'v3');
    const poolCalls = v3.map((v) => ({
      target: UNIV3_FACTORY as Address,
      allowFailure: true,
      callData: encodeFunctionData({
        abi: V3F,
        functionName: 'getPool',
        args: [tokenIn.address, tokenOut.address, v.fee],
      }),
    }));

    const poolRes = poolCalls.length
      ? ((await c.readContract({
          address: MULTICALL3,
          abi: MC3,
          functionName: 'aggregate3',
          args: [poolCalls],
        })) as readonly { success: boolean; returnData: `0x${string}` }[])
      : [];

    const v3Pools = new Map<string, Address>();
    v3.forEach((v, i) => {
      const r = poolRes[i];
      if (!r?.success) return;
      const pool = decodeFunctionResult({ abi: V3F, functionName: 'getPool', data: r.returnData }) as Address;
      if (pool !== ZERO) v3Pools.set(v.id, pool);
    });

    type Row = { venue: Venue; pool: Address };
    const rows: Row[] = [];
    for (const v of venues) {
      if (v.kind === 'v3') {
        const pool = v3Pools.get(v.id);
        if (pool) rows.push({ venue: v, pool });
      } else {
        rows.push({ venue: v, pool: v.pool });
      }
    }

    // Two balance reads per pool, one batch.
    const balCalls = rows.flatMap((r) =>
      [tokenIn.address, tokenOut.address].map((t) => ({
        target: t as Address,
        allowFailure: true,
        callData: encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [r.pool] }),
      })),
    );

    const balRes = balCalls.length
      ? ((await c.readContract({
          address: MULTICALL3,
          abi: MC3,
          functionName: 'aggregate3',
          args: [balCalls],
        })) as readonly { success: boolean; returnData: `0x${string}` }[])
      : [];

    const out = rows.map((r, i) => {
      const decode = (idx: number): bigint => {
        const res = balRes[idx];
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
      return {
        venue: r.venue,
        pool: r.pool,
        inventoryIn: decode(i * 2),
        inventoryOut: decode(i * 2 + 1),
      };
    });

    return NextResponse.json(
      jsonSafe({ tokenIn, tokenOut, venues: out.filter((r) => r.inventoryIn > 0n || r.inventoryOut > 0n) }),
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'venue lookup failed' },
      { status: 500 },
    );
  }
}
