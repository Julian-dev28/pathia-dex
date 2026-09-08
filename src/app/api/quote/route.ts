/**
 * GET /api/quote?in=WETH&out=USDC&amount=1.5
 *
 * Runs the ladder, picks the route, prices the gas, and returns the whole
 * working — every venue's curve, not just the winner. A quote you cannot audit
 * is a quote you have to trust, and the point of this project is that you
 * do not have to.
 *
 * Server-side because public RPC endpoints rate-limit per IP and a browser
 * firing a 12-rung ladder on every keystroke would be throttled within a
 * minute. Nothing secret lives here; the same calls work from anywhere.
 */

import { NextResponse } from 'next/server';
import { bySymbol } from '@/lib/chain';
import { quoteLadder, ladder, bestRoute, interpolate } from '@/lib/quote';
import { hopCostInToken, gasPriceWei, GAS_PER_EXTRA_HOP } from '@/lib/gas';
import { toBase, jsonSafe } from '@/lib/format';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const inSym = url.searchParams.get('in') ?? 'WETH';
  const outSym = url.searchParams.get('out') ?? 'USDC';
  const amountStr = url.searchParams.get('amount') ?? '1';

  try {
    const tokenIn = bySymbol(inSym);
    const tokenOut = bySymbol(outSym);
    if (tokenIn.address === tokenOut.address) {
      return NextResponse.json({ error: 'tokenIn and tokenOut are the same' }, { status: 400 });
    }

    const amountIn = toBase(amountStr, tokenIn);
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'amount must be greater than zero' }, { status: 400 });
    }

    const started = Date.now();
    const sizes = ladder(amountIn);
    const [curves, gasWei] = await Promise.all([
      quoteLadder(tokenIn, tokenOut, sizes),
      gasPriceWei(),
    ]);

    if (curves.length === 0) {
      return NextResponse.json(
        { error: `no liquidity found for ${inSym}/${outSym} on Base` },
        { status: 404 },
      );
    }

    const hopCost = await hopCostInToken(tokenOut, gasWei);
    const best = bestRoute(curves, amountIn, hopCost);

    return NextResponse.json(
      jsonSafe({
        tokenIn,
        tokenOut,
        amountIn,
        blockNumber: null,
        latencyMs: Date.now() - started,
        gas: {
          gasPriceWei: gasWei,
          gasPerExtraHop: GAS_PER_EXTRA_HOP,
          hopCostInOutputToken: hopCost,
          // A zero hop cost means the ETH→output conversion was unavailable,
          // not that gas is free. The UI must say which comparison it is
          // showing rather than quietly presenting a pre-gas number as net.
          gasAdjusted: hopCost > 0n,
        },
        route: best,
        venues: curves.map((c) => ({
          venue: c.venue,
          gasEstimate: c.gasEstimate,
          amountOutAtFull: interpolate(c, amountIn),
          rungs: c.rungs,
        })),
      }),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'quote failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
