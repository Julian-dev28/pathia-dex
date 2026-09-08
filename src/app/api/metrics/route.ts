/**
 * GET /api/metrics
 *
 * What this instance has been doing. In-process counters, so on serverless the
 * numbers are per-instance rather than per-product — which is the honest shape
 * for a deployment with no metrics backend, and is stated in the response so a
 * reader is not misled by a small number.
 */

import { NextResponse } from 'next/server';
import { metrics } from '@/lib/log';
import { quoteCache } from '@/lib/serve';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    {
      ...metrics.snapshot(),
      cacheEntries: quoteCache.size,
      scope: 'process',
      note: 'In-process counters. On serverless each instance reports only its own traffic.',
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
