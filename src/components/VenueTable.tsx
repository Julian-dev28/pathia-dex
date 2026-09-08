'use client';

import { useEffect, useMemo, useState } from 'react';
import { TOKENS, bySymbol, type Token } from '@/lib/chain';
import type { Venue } from '@/lib/quote';
import { sig, addr } from '@/lib/format';

type Row = { venue: Venue; pool: `0x${string}`; inventoryIn: bigint; inventoryOut: bigint };

export function VenueTable() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokenIn = useMemo(() => bySymbol(inSym), [inSym]);
  const tokenOut = useMemo(() => bySymbol(outSym), [outSym]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetch(`/api/venues?in=${inSym}&out=${outSym}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        setError(null);
        setRows(
          (body.venues as { venue: Venue; pool: `0x${string}`; inventoryIn: string; inventoryOut: string }[]).map(
            (v) => ({
              venue: v.venue,
              pool: v.pool,
              inventoryIn: BigInt(v.inventoryIn),
              inventoryOut: BigInt(v.inventoryOut),
            }),
          ),
        );
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [inSym, outSym]);

  const kind = (v: Venue) =>
    v.kind === 'v3' ? 'concentrated' : v.kind === 'aero' ? (v.stable ? 'stable' : 'volatile') : 'constant product';

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Venues</h1>
        <p className="page-sub">
          Every pool the router discovered for this pair, found by asking each factory rather than
          from a hardcoded list — and how much of each token that pool is actually holding right
          now.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Pool inventory</h2>
          <div className="section-meta flex items-center gap-2">
            <select className="token-select" value={inSym} onChange={(e) => setInSym(e.target.value)}>
              {TOKENS.map((t: Token) => (
                <option key={t.symbol}>{t.symbol}</option>
              ))}
            </select>
            <span className="mut">/</span>
            <select className="token-select" value={outSym} onChange={(e) => setOutSym(e.target.value)}>
              {TOKENS.map((t: Token) => (
                <option key={t.symbol}>{t.symbol}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="err">{error}</div>}
        {!rows && !error && <div className="empty">Scanning factories…</div>}

        {rows && (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th>Curve</th>
                  <th>Pool</th>
                  <th className="num">{tokenIn.symbol}</th>
                  <th className="num">{tokenOut.symbol}</th>
                </tr>
              </thead>
              <tbody>
                {[...rows]
                  .sort((a, b) => (a.inventoryOut > b.inventoryOut ? -1 : 1))
                  .map((r) => (
                    <tr key={r.venue.id}>
                      <td>{r.venue.label}</td>
                      <td>
                        <span className="badge b-mut">{kind(r.venue)}</span>
                      </td>
                      <td className="mono">
                        <a href={`https://basescan.org/address/${r.pool}`} target="_blank" rel="noreferrer">
                          {addr(r.pool)}
                        </a>
                      </td>
                      <td className="num mono">{sig(r.inventoryIn, tokenIn, 5)}</td>
                      <td className="num mono">{sig(r.inventoryOut, tokenOut, 5)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
          Inventory is the pool contract&rsquo;s ERC-20 balance, not <code className="mono">getReserves</code>.
          A V3 pool has no reserves function and a stable pool&rsquo;s reserves are not comparable to a
          constant-product pool&rsquo;s, so balances are the one figure that means the same thing in
          every row. For a concentrated pool, note that only the fraction of that balance sitting
          in range is available to the next trade — which is exactly why the router quotes rather
          than ranking by size.
        </p>
      </section>
    </>
  );
}
