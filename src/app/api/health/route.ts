/**
 * GET /api/health
 *
 * Liveness plus the two things that actually break in production: the RPC
 * endpoint going away, and the chain head going stale behind a cached or
 * lagging node. A health check that only returns `{ok: true}` from the web
 * process tells you the web process is up, which was never the question.
 */

import { NextResponse } from 'next/server';
import { client } from '@/lib/quote';
import { quoteCache } from '@/lib/serve';
import { CHAIN_ID, TOKENS } from '@/lib/chain';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/** Base produces a block roughly every two seconds. */
const STALE_AFTER_SECONDS = 60;

export async function GET() {
  const started = Date.now();

  try {
    const block = await client().getBlock();
    const ageSeconds = Math.floor(Date.now() / 1000 - Number(block.timestamp));
    const stale = ageSeconds > STALE_AFTER_SECONDS;

    return NextResponse.json(
      {
        status: stale ? 'degraded' : 'ok',
        chainId: CHAIN_ID,
        blockNumber: block.number.toString(),
        blockAgeSeconds: ageSeconds,
        rpcLatencyMs: Date.now() - started,
        tokens: TOKENS.length,
        cacheEntries: quoteCache.size,
        // Stated so a monitor can alert on the reason rather than on a bare
        // status string.
        detail: stale ? `chain head is ${ageSeconds}s old` : null,
      },
      { status: stale ? 503 : 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        status: 'down',
        chainId: CHAIN_ID,
        detail: e instanceof Error ? e.message.split('\n')[0] : 'rpc unreachable',
        rpcLatencyMs: Date.now() - started,
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
