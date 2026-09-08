import { aggregate } from '@/lib/dataset';
import { EdgeHistogram } from '@/components/EdgeHistogram';
import { bySymbol, EXPLORER } from '@/lib/chain';
import { sig, bps, addr } from '@/lib/format';

export const metadata = { title: 'Backtest' };

// Read at request time from the committed dataset. The file only changes on
// redeploy, and `loadRuns` caches it per process, so this costs one read per
// cold start rather than one per view.
export const dynamic = 'force-dynamic';

export default function Page() {
  const a = aggregate();

  if (a.samples === 0) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Backtest</h1>
          <p className="page-sub">No runs recorded yet. Run <code className="mono">npm run backtest</code>.</p>
        </div>
      </>
    );
  }

  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Backtest</h1>
        <p className="page-sub">
          Every trade below actually happened on Base. For each one the router was re-quoted at
          the block <em>before</em> it executed, and asked what it would have returned. This is
          the only measurement here about routing <em>quality</em> rather than correctness.
        </p>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Result</h2>
          <span className="section-meta">
            {a.runs} run{a.runs === 1 ? '' : 's'} · {a.observedTotal.toLocaleString('en-US')} swaps
            observed · {a.samples} replayed
          </span>
        </div>

        <div className="stat-row">
          <div className="kpi">
            <div className="sec-label">Median edge</div>
            <div className={`kv ${a.medianEdgeBps >= 0 ? 'up' : 'dn'}`}>
              {a.medianEdgeBps >= 0 ? '+' : ''}
              {a.medianEdgeBps.toFixed(1)}
              <span className="dec"> bp</span>
            </div>
            <div className="ksub">vs. the fill they actually got</div>
          </div>
          <div className="kpi">
            <div className="sec-label">Win rate</div>
            <div className="kv">{pct(a.winRate)}</div>
            <div className="ksub">
              {a.wins} better · {a.losses} worse · {a.ties} equal
            </div>
          </div>
          <div className="kpi">
            <div className="sec-label">Median win / loss</div>
            <div className="kv">
              +{a.medianWinBps.toFixed(0)}
              <span className="dec"> / {a.medianLossBps.toFixed(0)} bp</span>
            </div>
            <div className="ksub">asymmetry matters more than the average</div>
          </div>
          <div className="kpi">
            <div className="sec-label">p10 – p90</div>
            <div className="kv">
              {a.p10EdgeBps.toFixed(0)}
              <span className="dec"> … {a.p90EdgeBps >= 0 ? '+' : ''}{a.p90EdgeBps.toFixed(0)} bp</span>
            </div>
            <div className="ksub">the spread of outcomes</div>
          </div>
        </div>

        <div className="mt-6">
          <EdgeHistogram edges={a.edges} />
        </div>
      </section>

      <div className="row row-2">
        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">By pair</h2>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className="num">Samples</th>
                  <th className="num">Median edge</th>
                  <th className="num">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {a.byPair.map((p) => (
                  <tr key={p.pair}>
                    <td className="mono">{p.pair}</td>
                    <td className="num mono">{p.samples}</td>
                    <td className={`num mono ${p.medianEdgeBps >= 0 ? 'up' : 'dn'}`}>
                      {bps(p.medianEdgeBps)}
                    </td>
                    <td className="num mono">{pct(p.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Venue the router chose</h2>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Venue</th>
                  <th className="num">Times chosen</th>
                </tr>
              </thead>
              <tbody>
                {a.byVenue.map((v) => (
                  <tr key={v.venue}>
                    <td>{v.venue}</td>
                    <td className="num mono">{v.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
            {a.multiHopUsed} of {a.samples} replays routed through an intermediate token.
          </p>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Replayed trades</h2>
          <span className="section-meta">most recent first</span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th className="num">Size</th>
                <th className="num">They got</th>
                <th className="num">Router</th>
                <th className="num">Edge</th>
                <th>Route</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {a.recent.map((s) => {
                const [inSym, outSym] = s.pair.split('/');
                const tIn = bySymbol(inSym);
                const tOut = bySymbol(outSym);
                return (
                  <tr key={`${s.txHash}-${s.blockNumber}`}>
                    <td className="mono">{s.pair}</td>
                    <td className="num mono">{sig(BigInt(s.amountIn), tIn, 4)}</td>
                    <td className="num mono">{sig(BigInt(s.actualOut), tOut, 6)}</td>
                    <td className="num mono">{sig(BigInt(s.routerOut), tOut, 6)}</td>
                    <td className={`num mono ${s.edgeBps > 0 ? 'up' : s.edgeBps < 0 ? 'dn' : 'mut'}`}>
                      {bps(s.edgeBps)}
                    </td>
                    <td className="mut" style={{ fontSize: 12 }}>
                      {s.routerVenue}
                      {s.routerHops > 1 && (
                        <span className="badge b-hop" style={{ marginLeft: 6 }}>
                          {s.routerHops} hops
                        </span>
                      )}
                    </td>
                    <td className="mono">
                      <a href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                        {addr(s.txHash)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">What this does and does not show</h2>
        </div>
        <div className="prose" style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)', maxWidth: '78ch' }}>
          <p>
            <strong>Corrected for.</strong> Each trade is re-quoted at the block <em>before</em>
            it executed, because its own swap moved the pool it landed in — quoting at the same
            height would price a market the trader never saw. Transactions containing more than
            one Swap log are discarded entirely: a single leg of somebody else&rsquo;s multi-hop
            route is not a complete trade, and comparing our whole route against one leg of
            theirs would flatter this project enormously.
          </p>
          <p className="mt-2">
            <strong>Not corrected for.</strong> The comparison is gross of gas on both sides —
            we do not know what they paid, and our own extra-hop cost is not netted out either,
            which if anything favours the observed trade. We also cannot see <em>why</em> they
            routed as they did: a trade that looks beatable may have been a deliberate choice of
            venue, an MEV-protected order, or one leg of an intent that settled elsewhere.
          </p>
          <p className="mt-2">
            <strong>The sample is small and recent.</strong> Public RPC serves roughly three
            thousand blocks of logs and a few thousand blocks of historical state, so each run
            samples the last few hours. The dataset accumulates depth over time rather than in
            one pass, and every figure on this page is recomputed from{' '}
            <code className="mono">data/backtest.jsonl</code>, which is committed — so any claim
            here is auditable in the diff that introduced it.
          </p>
        </div>
      </section>
    </>
  );
}
