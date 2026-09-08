/**
 * GET /api/quote?in=WETH&out=USDC&amount=1.5
 *
 * Runs the ladder, picks the route, prices the gas, and returns the whole
 * working — every venue's curve, not just the winner. A quote you cannot audit
 * is a quote you have to trust, and the point of this project is that you do
 * not have to.
 *
 * Server-side because public RPC endpoints rate-limit per IP and a browser
 * firing a laddered quote on every keystroke would be throttled within a
 * minute. Nothing secret lives here; the same calls work from anywhere.
 */

import { NextResponse } from 'next/server';
import { bySymbol, TOKENS } from '@/lib/chain';
import { client, quoteLadder, ladder, bestRoute, interpolate, isMultiHop } from '@/lib/quote';
import { hopCostInToken, gasPriceWei, GAS_PER_EXTRA_HOP } from '@/lib/gas';
import { toBase, jsonSafe } from '@/lib/format';
import { quoteCache, quoteLimit, clientKey, QUOTE_TTL_MS } from '@/lib/serve';
import { log, metrics } from '@/lib/log';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Rejects absurd inputs before they reach the chain. */
const MAX_AMOUNT_DIGITS = 30;

export async function GET(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  metrics.inc('quote.requests');
  if (!limit.ok) {
    metrics.inc('quote.rate_limited');
    return NextResponse.json(
      { error: 'rate limit exceeded — slow down' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)),
          'x-ratelimit-remaining': '0',
        },
      },
    );
  }

  const url = new URL(req.url);
  const inSym = url.searchParams.get('in') ?? 'WETH';
  const outSym = url.searchParams.get('out') ?? 'USDC';
  const amountStr = (url.searchParams.get('amount') ?? '1').trim();

  try {
    if (amountStr.length > MAX_AMOUNT_DIGITS || !/^\d*\.?\d*$/.test(amountStr)) {
      return NextResponse.json({ error: 'amount is not a number' }, { status: 400 });
    }

    const tokenIn = bySymbol(inSym);
    const tokenOut = bySymbol(outSym);
    if (tokenIn.address === tokenOut.address) {
      return NextResponse.json({ error: 'tokenIn and tokenOut are the same' }, { status: 400 });
    }

    const amountIn = toBase(amountStr, tokenIn);
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'amount must be greater than zero' }, { status: 400 });
    }

    const key = `${tokenIn.symbol}:${tokenOut.symbol}:${amountIn}`;
    const started = Date.now();

    const { value, hit } = await quoteCache.get(key, async () => {
      const sizes = ladder(amountIn);
      // The block is read alongside the quotes rather than after them, so the
      // number reported is the height the prices belong to. Provenance is the
      // whole product here; "roughly now" is not good enough.
      const gasWei = await gasPriceWei();

      // The gas conversion does not depend on the route, so it goes out with
      // the ladder rather than after it. Awaiting it separately added a full
      // round trip to every quote.
      const [curves, blockNumber, hopCost] = await Promise.all([
        quoteLadder(tokenIn, tokenOut, sizes),
        client().getBlockNumber(),
        hopCostInToken(tokenOut, gasWei),
      ]);

      if (curves.length === 0) return null;

      const best = bestRoute(curves, amountIn, hopCost);

      return {
        tokenIn,
        tokenOut,
        amountIn,
        blockNumber,
        gas: {
          gasPriceWei: gasWei,
          gasPerExtraHop: GAS_PER_EXTRA_HOP,
          hopCostInOutputToken: hopCost,
          // A zero hop cost means the ETH→output conversion was unavailable,
          // not that gas is free. The UI must say which comparison it is
          // showing rather than presenting a pre-gas number as net.
          gasAdjusted: hopCost > 0n,
        },
        route: best,
        venues: curves.map((c) => ({
          venue: c.venue,
          gasEstimate: c.gasEstimate,
          amountOutAtFull: interpolate(c, amountIn),
          multiHop: isMultiHop(c.venue),
          rungs: c.rungs,
        })),
      };
    });

    if (!value) {
      metrics.inc('quote.no_liquidity');
      return NextResponse.json(
        { error: `no liquidity found for ${inSym}/${outSym} on Base` },
        { status: 404 },
      );
    }

    const elapsed = Date.now() - started;
    metrics.inc(hit ? 'quote.cache_hit' : 'quote.cache_miss');
    if (!hit) metrics.observeLatency(elapsed);

    return NextResponse.json(
      jsonSafe({
        ...(value as object),
        quotedAt: Date.now(),
        expiresAt: Date.now() + QUOTE_TTL_MS,
        latencyMs: elapsed,
        cached: hit,
      }),
      {
        headers: {
          'cache-control': 'no-store',
          'x-ratelimit-remaining': String(limit.remaining),
        },
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'quote failed';
    metrics.inc('quote.errors');
    log.error('quote.failed', { pair: `${inSym}/${outSym}`, amount: amountStr, message });
    // Unknown-token errors are the caller's fault, not ours, and returning 500
    // for them makes a typo look like an outage.
    const known = TOKENS.some((t) => t.symbol === inSym) && TOKENS.some((t) => t.symbol === outSym);
    return NextResponse.json({ error: message }, { status: known ? 500 : 400 });
  }
}
