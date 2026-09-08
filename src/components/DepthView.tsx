'use client';

import { useEffect, useMemo, useState } from 'react';
import { TOKENS, bySymbol } from '@/lib/chain';
import { fetchQuote, type QuoteResponse } from '@/lib/api';
import { sig, bps } from '@/lib/format';
import { DepthChart } from './DepthChart';
import { TokenSelect } from './TokenSelect';

const SIZES = ['0.1', '1', '10', '50'];
const SERIES_CLASS = ['vc-0', 'vc-1', 'vc-2', 'vc-3', 'vc-4'];

export function DepthView() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [amount, setAmount] = useState('10');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tokenIn = useMemo(() => bySymbol(inSym), [inSym]);
  const tokenOut = useMemo(() => bySymbol(outSym), [outSym]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchQuote(inSym, outSym, amount)
      .then((q) => !cancelled && (setQuote(q), setError(null)))
      .catch((e) => !cancelled && (setError(e.message), setQuote(null)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [inSym, outSym, amount]);

  /**
   * Price impact at the top rung against the smallest rung, per venue. This is
   * the number a desk actually asks for — "what does it cost me to do size
   * here" — and it is the same data the chart draws, stated once in figures.
   */
  const impact = useMemo(() => {
    if (!quote) return [];
    return quote.venues
      .map((v) => {
        const first = v.rungs[0];
        const last = v.rungs[v.rungs.length - 1];
        if (!first || !last || first.amountIn === 0n || last.amountIn === 0n) return null;
        const pxSmall = Number(first.amountOut) / Number(first.amountIn);
        const pxFull = Number(last.amountOut) / Number(last.amountIn);
        if (!Number.isFinite(pxSmall) || pxSmall === 0) return null;
        return {
          venue: v.venue,
          impactBps: ((pxFull - pxSmall) / pxSmall) * 10_000,
          amountOutAtFull: v.amountOutAtFull,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.amountOutAtFull > b.amountOutAtFull ? -1 : 1));
  }, [quote]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Depth</h1>
        <p className="page-sub">
          Effective price against trade size, quoted live from each pool. Where two lines cross
          is the size at which the best venue changes — and the reason a router splits at all.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Pair</h2>
          <div className="section-meta flex items-center gap-2">
            <TokenSelect value={inSym} onChange={setInSym} tokens={TOKENS} exclude={outSym} />
            <span className="mut">→</span>
            <TokenSelect value={outSym} onChange={setOutSym} tokens={TOKENS} exclude={inSym} />
            <span className="seg" style={{ marginLeft: 10 }}>
              {SIZES.map((s) => (
                <button
                  key={s}
                  className={`range-btn${amount === s ? ' on' : ''}`}
                  onClick={() => setAmount(s)}
                >
                  {s}
                </button>
              ))}
            </span>
          </div>
        </div>

        {error && <div className="err">{error}</div>}
        {loading && !quote && <div className="empty">Quoting every venue…</div>}

        {quote && (
          <>
            <DepthChart venues={quote.venues} tokenIn={tokenIn} tokenOut={tokenOut} />
            <div className="legend mt-3">
              {quote.venues.slice(0, 5).map((v, i) => (
                <span key={v.venue.id}>
                  <span className={`leg-dot ${SERIES_CLASS[i % 5]}`} />
                  {v.venue.label}
                </span>
              ))}
            </div>
            <p className="mt-2" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              X axis is trade size in {tokenIn.symbol}, log-spaced. Y axis is {tokenOut.symbol}{' '}
              received per {tokenIn.symbol}, windowed to the top 45% of the price range so a
              drained pool cannot flatten the venues that matter.
            </p>
          </>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">
            Price impact at {amount} {inSym}
          </h2>
        </div>
        {impact.length === 0 ? (
          <div className="empty">No venues quoted.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th className="num">Output</th>
                  <th className="num">Impact</th>
                </tr>
              </thead>
              <tbody>
                {impact.map((r) => (
                  <tr key={r.venue.id}>
                    <td>{r.venue.label}</td>
                    <td className="num mono">
                      {sig(r.amountOutAtFull, tokenOut)} {tokenOut.symbol}
                    </td>
                    <td className={`num mono ${r.impactBps < -50 ? 'dn' : 'mut'}`}>
                      {bps(r.impactBps)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
