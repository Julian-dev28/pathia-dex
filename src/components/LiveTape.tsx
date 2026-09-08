'use client';

import { useEffect, useRef, useState } from 'react';
import type { Token } from '@/lib/chain';
import { sig } from '@/lib/format';

type Tick = {
  blockNumber: string;
  amountOut: string;
  venue: string | null;
  path: string[];
  hops: number;
  chosen: 'single' | 'split';
  netEdgeBps: number;
  at: number;
};

type Status = 'connecting' | 'live' | 'stalled' | 'closed';

/**
 * The price tape: quotes pushed from `/api/stream` as blocks land.
 *
 * This is deliberately *not* the number the trade form signs against. The form
 * owns its own quote with an explicit expiry, because a price that changes
 * under the user between reading and clicking is how people get a fill they did
 * not agree to. The tape is for watching the market move; the form is for
 * trading. Conflating the two would make the interface feel more live and be
 * less safe.
 *
 * The server only pushes when the quote actually changed, so a quiet tape means
 * a quiet market rather than a broken connection — which is why the status
 * flips to "stalled" on a timer rather than on the absence of messages alone.
 */
export function LiveTape({
  inSym,
  outSym,
  amount,
  tokenOut,
}: {
  inSym: string;
  outSym: string;
  amount: string;
  tokenOut: Token;
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const lastEventAt = useRef(Date.now());

  useEffect(() => {
    setTicks([]);
    setStatus('connecting');
    lastEventAt.current = Date.now();

    const url = `/api/stream?in=${encodeURIComponent(inSym)}&out=${encodeURIComponent(
      outSym,
    )}&amount=${encodeURIComponent(amount)}`;
    const es = new EventSource(url);

    es.addEventListener('open', () => setStatus('live'));

    es.addEventListener('quote', (e) => {
      lastEventAt.current = Date.now();
      setStatus('live');
      try {
        const data = JSON.parse((e as MessageEvent).data);
        // Newest first, bounded — an unbounded tape is a memory leak on a page
        // someone leaves open.
        setTicks((prev) => [{ ...data, at: Date.now() }, ...prev].slice(0, 8));
      } catch {
        /* malformed frame; drop it rather than break the tape */
      }
    });

    es.addEventListener('bye', () => {
      setStatus('closed');
      es.close();
    });

    // EventSource reconnects on its own; this only reflects the current state.
    es.onerror = () => setStatus((s) => (s === 'closed' ? s : 'stalled'));

    const stallCheck = setInterval(() => {
      setStatus((s) => {
        if (s === 'closed') return s;
        return Date.now() - lastEventAt.current > 45_000 ? 'stalled' : s;
      });
    }, 5_000);

    return () => {
      clearInterval(stallCheck);
      es.close();
    };
  }, [inSym, outSym, amount]);

  const label: Record<Status, string> = {
    connecting: 'connecting',
    live: 'streaming',
    stalled: 'quiet',
    closed: 'ended',
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="sec-label">Live tape</h2>
        <span className="section-meta">
          <span className={`pill${status === 'live' ? '' : status === 'closed' ? ' offline' : ' stale'}`}>
            {label[status]}
          </span>
        </span>
      </div>

      {ticks.length === 0 ? (
        <div className="empty">
          Waiting for the next block that moves this price. The stream only pushes when the
          quote actually changes.
        </div>
      ) : (
        <div className="tape">
          {ticks.map((t, i) => {
            const prev = ticks[i + 1];
            const delta = prev ? BigInt(t.amountOut) - BigInt(prev.amountOut) : 0n;
            return (
              <div className="tape-line" key={`${t.blockNumber}-${t.at}`}>
                <span className="mono mut">{t.blockNumber}</span>
                <span className="mono">
                  {sig(BigInt(t.amountOut), tokenOut, 7)} {tokenOut.symbol}
                </span>
                <span className={`mono ${delta > 0n ? 'up' : delta < 0n ? 'dn' : 'mut'}`}>
                  {prev ? (delta > 0n ? '▲' : delta < 0n ? '▼' : '·') : ''}
                </span>
                <span className="mut" style={{ fontSize: 11.5 }}>
                  {t.path.join(' → ')}
                </span>
                <span className="mut" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
                  {t.venue}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-2" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        Server-sent events, coalesced to at most one quote every six seconds and skipped entirely
        when the price has not moved. This tape is for watching; the trade form keeps its own
        quote with an explicit expiry, so what you sign is never something that changed under you.
      </p>
    </section>
  );
}
