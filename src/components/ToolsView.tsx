'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOKENS, bySymbol, EXPLORER } from '@/lib/chain';
import { sig, bps, addr } from '@/lib/format';
import { TokenSelect } from './TokenSelect';

type Analysis = {
  tokenIn: { symbol: string; decimals: number };
  tokenOut: { symbol: string; decimals: number };
  blockNumber: string;
  quotedOut: string;
  bestVenue: string | null;
  latencyMs: number;
  exposure: {
    slippageBps: number;
    exposure: string;
    floor: string;
    atRecommended: { slippageBps: number; exposure: string };
    savedByTightening: string;
  };
  drift: {
    pool: string;
    legs?: number;
    lookbackBlocks?: number;
    observations: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    inclusionBlocks: number;
  } | null;
  recommendation: {
    recommendedBps: number;
    observations: number;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    savedVsDefaultBps: number;
  };
  capacity: { maxImpactBps: number; venue: string; size: string; atLeast: boolean }[];
  fragmentation: { percent: number; venuesInSplit: number; venuesQuoted: number };
  arb: {
    buy: { venue: string };
    sell: { venue: string };
    size: string;
    grossBps: number;
    netBps: number;
    profitable: boolean;
  } | null;
};

const SLIPPAGE_CHOICES = [10, 30, 50, 100];

export function ToolsView() {
  const [inSym, setInSym] = useState('WETH');
  const [outSym, setOutSym] = useState('USDC');
  const [amount, setAmount] = useState('1');
  const [slippageBps, setSlippageBps] = useState(50);
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenIn = useMemo(() => bySymbol(inSym), [inSym]);
  const tokenOut = useMemo(() => bySymbol(outSym), [outSym]);

  const abortRef = useRef<AbortController | null>(null);
  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/analyze?in=${inSym}&out=${outSym}&amount=${encodeURIComponent(amount)}&slippage=${slippageBps}`,
        { signal: ctrl.signal, cache: 'no-store' },
      );
      const body = await res.json();
      if (ctrl.signal.aborted) return;
      if (body.error) {
        setError(body.error);
        setData(null);
      } else {
        setData(body as Analysis);
        setError(null);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String(e));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [inSym, outSym, amount, slippageBps]);

  useEffect(() => {
    const t = setTimeout(run, 400);
    return () => clearTimeout(t);
  }, [run]);

  const dec = (v: string, decimals: number) => Number(v) / 10 ** decimals;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Execution tools</h1>
        <p className="page-sub">
          Five measurements a swap interface could show you and none of them do. All of it falls
          out of quoting the pair in both directions — the same work a quote already does.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Trade</h2>
          <div className="section-meta flex items-center gap-2">
            <input
              className="tsel-trigger"
              style={{ width: 96 }}
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount"
            />
            <TokenSelect value={inSym} onChange={setInSym} tokens={TOKENS} exclude={outSym} />
            <span className="mut">→</span>
            <TokenSelect value={outSym} onChange={setOutSym} tokens={TOKENS} exclude={inSym} />
            <span className="seg" style={{ marginLeft: 8 }}>
              {SLIPPAGE_CHOICES.map((s) => (
                <button
                  key={s}
                  className={`range-btn${slippageBps === s ? ' on' : ''}`}
                  onClick={() => setSlippageBps(s)}
                  type="button"
                >
                  {(s / 100).toFixed(2)}%
                </button>
              ))}
            </span>
          </div>
        </div>
        {error && <div className="err">{error}</div>}
        {loading && !data && <div className="empty">Quoting both directions…</div>}
      </section>

      {data && (
        <>
          {/* ── 1. MEV exposure ────────────────────────────────────── */}
          <section className="section">
            <div className="section-head">
              <h2 className="sec-label">1 · Sandwich exposure</h2>
              <span className="section-meta">
                block {data.blockNumber} · {data.latencyMs} ms
              </span>
            </div>

            <div className="stat-row">
              <div className="kpi">
                <div className="sec-label">At your {data.exposure.slippageBps} bp</div>
                <div className="kv dn">
                  {dec(data.exposure.exposure, data.tokenOut.decimals).toLocaleString('en-US', {
                    maximumFractionDigits: 4,
                  })}
                  <span className="dec"> {data.tokenOut.symbol}</span>
                </div>
                <div className="ksub">most a sandwich can take</div>
              </div>
              <div className="kpi">
                <div className="sec-label">
                  At the recommended {data.exposure.atRecommended.slippageBps} bp
                </div>
                <div className="kv up">
                  {dec(
                    data.exposure.atRecommended.exposure,
                    data.tokenOut.decimals,
                  ).toLocaleString('en-US', { maximumFractionDigits: 4 })}
                  <span className="dec"> {data.tokenOut.symbol}</span>
                </div>
                <div className="ksub">same trade, tighter floor</div>
              </div>
              <div className="kpi">
                <div className="sec-label">Taken off the table</div>
                <div className="kv">
                  {dec(data.exposure.savedByTightening, data.tokenOut.decimals).toLocaleString(
                    'en-US',
                    { maximumFractionDigits: 4 },
                  )}
                  <span className="dec"> {data.tokenOut.symbol}</span>
                </div>
                <div className="ksub">by tightening alone</div>
              </div>
            </div>

            <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
              A slippage tolerance is not a safety margin — it is a standing offer. An attacker can
              push the pool until you receive exactly your minimum and keep the difference, so the
              gap between the quote and your floor is the maximum they can extract. This figure is
              arithmetic on numbers you authorised, not an estimate.
            </p>
          </section>

          {/* ── 2. Measured drift ──────────────────────────────────── */}
          <section className="section">
            <div className="section-head">
              <h2 className="sec-label">2 · Slippage, measured rather than guessed</h2>
              <span className="section-meta">
                <span
                  className={`badge ${
                    data.recommendation.confidence === 'high'
                      ? 'b-pass'
                      : data.recommendation.confidence === 'medium'
                        ? 'b-chop'
                        : 'b-mut'
                  }`}
                >
                  {data.recommendation.confidence} confidence
                </span>
              </span>
            </div>

            {data.drift ? (
              <>
                <div className="stat-row">
                  <div className="kpi">
                    <div className="sec-label">Recommended</div>
                    <div className="kv">
                      {data.recommendation.recommendedBps}
                      <span className="dec"> bp</span>
                    </div>
                    <div className="ksub">
                      vs. the 50 bp every wallet ships
                      {data.recommendation.savedVsDefaultBps > 0 &&
                        ` — ${data.recommendation.savedVsDefaultBps} bp tighter`}
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="sec-label">Drift p95</div>
                    <div className="kv">
                      {data.drift.p95.toFixed(2)}
                      <span className="dec"> bp</span>
                    </div>
                    <div className="ksub">
                      over {data.drift.inclusionBlocks}-block windows
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="sec-label">Evidence</div>
                    <div className="kv">{data.drift.observations}</div>
                    <div className="ksub">
                      windows over {data.drift.lookbackBlocks} blocks
                      {data.drift.legs === 2 && ', both legs'}
                    </div>
                  </div>
                  <div className="kpi">
                    <div className="sec-label">Worst seen</div>
                    <div className="kv">
                      {data.drift.max.toFixed(2)}
                      <span className="dec"> bp</span>
                    </div>
                    <div className="ksub">p50 {data.drift.p50.toFixed(2)} · p99 {data.drift.p99.toFixed(2)}</div>
                  </div>
                </div>
                <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                  {data.recommendation.reason}. Measured from{' '}
                  <a href={`${EXPLORER}/address/${data.drift.pool}`} target="_blank" rel="noreferrer" className="mono">
                    {addr(data.drift.pool)}
                  </a>{' '}
                  — Uniswap V3 Swap events carry the pool price, so one log query reconstructs the
                  whole series without an archive node or a price feed.
                </p>
              </>
            ) : (
              <div className="empty">
                Not enough recent trades on this pair to measure drift, so the conservative default
                stands. An unmeasured pair is exactly where a confident number would do most harm.
              </div>
            )}
          </section>

          <div className="row row-2">
            {/* ── 3. Capacity ─────────────────────────────────────── */}
            <section className="section">
              <div className="section-head">
                <h2 className="sec-label">3 · Capacity</h2>
                <span className="section-meta">{data.capacity[0]?.venue}</span>
              </div>
              <div className="scroll-x">
                <table>
                  <thead>
                    <tr>
                      <th>Impact budget</th>
                      <th className="num">Max size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.capacity.map((c) => (
                      <tr key={c.maxImpactBps}>
                        <td className="mono">≤ {c.maxImpactBps} bp</td>
                        <td className="num mono">
                          {c.atLeast && <span className="mut">≥ </span>}
                          {sig(BigInt(c.size), tokenIn, 6)} {data.tokenIn.symbol}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                How much this pair absorbs before impact exceeds a budget — the first question a
                desk asks and the one no interface answers. A ≥ means the whole quoted range fits,
                so the true figure is higher.
              </p>
            </section>

            {/* ── 4. Fragmentation ────────────────────────────────── */}
            <section className="section">
              <div className="section-head">
                <h2 className="sec-label">4 · Fragmentation</h2>
              </div>
              <div className="stat-row">
                <div className="kpi">
                  <div className="sec-label">Off the best venue</div>
                  <div className="kv">
                    {data.fragmentation.percent.toFixed(1)}
                    <span className="dec">%</span>
                  </div>
                  <div className="ksub">
                    of optimal execution, across {data.fragmentation.venuesInSplit} of{' '}
                    {data.fragmentation.venuesQuoted} venues
                  </div>
                </div>
              </div>
              <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                Zero means one pool is the whole market and a router earns nothing here. It is
                published precisely because it is sometimes unflattering: on deep pairs at small
                size, this number says routing does not matter.
              </p>
            </section>
          </div>

          {/* ── 5. Arbitrage ───────────────────────────────────────── */}
          <section className="section">
            <div className="section-head">
              <h2 className="sec-label">5 · Cross-venue round trip</h2>
              <span className="section-meta">
                {data.arb?.profitable ? (
                  <span className="badge b-pass">opportunity</span>
                ) : (
                  <span className="badge b-mut">none profitable</span>
                )}
              </span>
            </div>

            {data.arb ? (
              <>
                <div className="route-row">
                  <span>
                    Buy on <strong>{data.arb.buy.venue}</strong>, sell on{' '}
                    <strong>{data.arb.sell.venue}</strong>
                  </span>
                  <span className="mono">
                    {sig(BigInt(data.arb.size), tokenIn, 5)} {data.tokenIn.symbol}
                  </span>
                </div>
                <div className="route-row">
                  <span className="mut">Gross / net of gas</span>
                  <span className="mono">
                    <span className={data.arb.grossBps > 0 ? 'up' : 'dn'}>{bps(data.arb.grossBps)}</span>
                    {' · '}
                    <span className={data.arb.netBps > 0 ? 'up' : 'dn'}>{bps(data.arb.netBps)}</span>
                  </span>
                </div>
              </>
            ) : (
              <div className="empty">No profitable round trip at any size on this pair.</div>
            )}

            <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
              Both legs move against you as size grows, so profit is concave and the optimum is a
              specific size rather than &ldquo;as much as possible&rdquo; — taking the maximum is how a
              naive searcher turns an edge into a loss. Expect this to read <em>none</em> almost
              always: these opportunities are contested by searchers with far better latency and
              close within a block. Reporting nothing is the honest answer, not a broken feature.
            </p>
          </section>
        </>
      )}
    </>
  );
}
