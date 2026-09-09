export const metadata = { title: 'Method — Pathia DEX' };

/**
 * The docs page is where the project either earns trust or loses it. It states
 * the method, then states what the method cannot do. A page that only lists
 * strengths reads as marketing; the limitations section is the part a reader
 * who knows the domain will check first.
 */
export default function Page() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Method</h1>
        <p className="page-sub">
          How a route is computed here, what the numbers mean, and where they stop being
          reliable.
        </p>
      </div>

      <div className="row row-2">
        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Discovery</h2>
          </div>
          <div className="prose" style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)' }}>
            <p>
              Nothing is hardcoded except factory addresses. For a given pair the router asks
              Uniswap V2, SushiSwap and BaseSwap for their pair, Aerodrome for both its stable
              and volatile pool, and lists the fee tiers of each concentrated-liquidity
              deployment — Uniswap V3 and PancakeSwap V3 — then repeats all of that through
              each intermediate token, so a two-hop route is a candidate on the same footing as
              a direct one. Tiers with no pool revert at quote time and drop out.
            </p>
            <p className="mt-2">
              A V3 fork is a row in a table, not a code path. What forks do <em>not</em> share
              is the router: PancakeSwap forked Uniswap&rsquo;s original{' '}
              <code className="mono">SwapRouter</code>, whose swap params carry a deadline,
              while Uniswap moved to <code className="mono">SwapRouter02</code>, which does not.
              Encoding one against the other reverts every swap on that venue, so the difference
              is read out of the deployed bytecode rather than assumed.
            </p>
            <p className="mt-2">
              The candidate set is deliberately wide and pruned by price rather than by
              guesswork: every candidate is quoted once at full size, and only the best six
              receive the full ladder. Laddering all of them would be roughly a hundred and
              eighty contract calls.
            </p>
            <p className="mt-2">
              Every address in <code className="mono">src/lib/chain.ts</code> is checked for
              bytecode, and every token&rsquo;s <code className="mono">symbol()</code> and{' '}
              <code className="mono">decimals()</code> is read from the chain. Both run in CI. A
              token entry with the right address and the wrong decimals misprices every trade in
              it by a factor of a thousand, silently.
            </p>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="sec-label">Quoting</h2>
          </div>
          <div className="prose" style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)' }}>
            <p>
              Constant-product venues are quoted off-chain from their reserves, with the fee
              numerator that fork actually uses — BaseSwap takes 25bp where Uniswap V2 takes 30,
              and one shared constant would misprice every BaseSwap trade. All arithmetic is
              bigint; a float in this path is a rounding error denominated in money.
            </p>
            <p className="mt-2">
              Aerodrome and Uniswap V3 are quoted on-chain. A Solidly stable curve and a
              concentrated-liquidity tick walk can be reimplemented off-chain, and a
              reimplementation that drifts by one tick is worse than no reimplementation, so the
              pool is asked directly. Every quote at every size goes out in one
              <code className="mono"> Multicall3.aggregate3 </code> round trip.
            </p>
          </div>
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Solving the split</h2>
        </div>
        <div className="prose" style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)', maxWidth: '78ch' }}>
          <p>
            Each venue is quoted at a geometric ladder of sizes, which yields an output curve per
            venue rather than a single number. Because a pool&rsquo;s output is concave in size — the
            second unit always buys less than the first — handing each successive slice of the
            trade to whichever venue offers the best <em>marginal</em> rate converges on the optimal
            allocation. That is the same water-filling argument used for power allocation across
            channels. The trade is cut into 32 slices; the residual against a finer solve has been
            under a basis point on every pair measured.
          </p>
          <p className="mt-2">
            Interpolation between ladder rungs is piecewise-linear, which on a concave function
            underestimates. That is the safe direction: the solver will never believe a venue is
            deeper than it is.
          </p>
          <p className="mt-2">
            Direct and two-hop routes compete as equals in this allocation. A two-hop route pays
            its fee twice, so it only wins where the direct pool is thin enough for price impact
            to dominate the extra fee — which on Base is most long-tail tokens, whose entire
            liquidity is paired against WETH. Measured across twenty-four benchmark cases,
            multi-hop was the best route in eight.
          </p>
          <p className="mt-2">
            Splitting is then charged for what it costs. Each additional venue is another pool
            touched, so the split only wins if it beats the best single venue by more than the
            extra gas — converted into the output token using the same pools the router already
            quoted, so no price API is involved. An aggregator that reports a 3bp gain on a trade
            whose extra hop costs 6bp of gas is flattering itself, and the{' '}
            <span className="mono">net of gas</span> figure on the terminal is the one that
            settles it.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Limitations</h2>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Consequence</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>No Uniswap V4</td>
                <td>
                  V4 is live on Base and quotes competitively, but it settles through
                  UniversalRouter with Permit2 and an encoded action sequence rather than a
                  router call. This app does not quote what it cannot execute, so V4 stays out
                  until that path is written. Hooked pools are unenumerable in any case — a pool
                  behind an arbitrary hook address cannot be found by guessing keys.
                </td>
              </tr>
              <tr>
                <td>Two hops maximum</td>
                <td>
                  Routes go A→B or A→X→B where X is WETH or USDC. Three-hop routes exist and are
                  not searched, and a token paired only against something other than WETH or USDC
                  is invisible to the solver.
                </td>
              </tr>
              <tr>
                <td>Execution is single-venue</td>
                <td>
                  The solved split is analysis. Executing it atomically needs a router contract
                  holding the intermediate balance; that contract is written and fork-tested in{' '}
                  <code className="mono">contracts/</code> but is not deployed, because shipping
                  an unaudited contract that touches user funds to capture a basis point is a bad
                  trade.
                </td>
              </tr>
              <tr>
                <td>Quote staleness</td>
                <td>
                  A quote is refused for signing after 30 seconds and re-fetched. That is a
                  backstop against a tab left open, not a freshness guarantee — Base blocks are
                  two seconds, so a 30-second quote is already many blocks stale.
                </td>
              </tr>
              <tr>
                <td>Quotes are a block old</td>
                <td>
                  Every number here was true at the block it was read at. The minimum-output
                  floor, enforced on-chain by the venue&rsquo;s own router, is what protects the
                  fill — not the freshness of this page.
                </td>
              </tr>
              <tr>
                <td>No MEV protection</td>
                <td>
                  Transactions go to the public mempool. Base&rsquo;s sequencer is first-come rather
                  than an auction, which limits sandwiching relative to Ethereum L1, but it is not
                  a guarantee and this project does not offer one.
                </td>
              </tr>
              <tr>
                <td>Fee-on-transfer tokens unsupported</td>
                <td>
                  The quote assumes the amount sent is the amount received by the pool. A token
                  that taxes transfers will quote high and can revert on the minimum-output check.
                </td>
              </tr>
              <tr>
                <td>Public RPC</td>
                <td>
                  Rate limits are real. The quote path batches into one call per stage to stay
                  inside them; heavy use wants a dedicated endpoint via{' '}
                  <code className="mono">RPC_URL</code>.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">API</h2>
          <span className="section-meta">
            <a href="/api/openapi">openapi.json</a>
          </span>
        </div>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>What it returns</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">GET /api/quote</td>
                <td>
                  The solved route plus every venue curve behind it. Cached 3s with request
                  coalescing; 120 requests per minute per IP.
                </td>
              </tr>
              <tr>
                <td className="mono">GET /api/venues</td>
                <td>Every pool considered for a pair, including mid-route pools, with balances.</td>
              </tr>
              <tr>
                <td className="mono">GET /api/stream</td>
                <td>
                  Server-sent events. A re-quote when a block changes the answer — coalesced to
                  one every six seconds, silent when the price has not moved.
                </td>
              </tr>
              <tr>
                <td className="mono">GET /api/health</td>
                <td>
                  Chain height, block age, RPC latency. Returns 503 when the head goes stale,
                  which is the failure a bare liveness check misses.
                </td>
              </tr>
              <tr>
                <td className="mono">GET /api/metrics</td>
                <td>In-process counters and quote latency percentiles, for this instance only.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3" style={{ fontSize: 12.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
          No authentication, because there is nothing to authenticate: every endpoint reads
          public chain state and the same calls work from anywhere. Amounts cross the wire as
          base-unit integers in strings, since JSON has no bigint.
        </p>
      </section>

      <section className="section">
        <div className="section-head">
          <h2 className="sec-label">Independence</h2>
        </div>
        <div className="prose" style={{ fontSize: 13.5, lineHeight: 1.65, color: 'var(--ink-2)', maxWidth: '78ch' }}>
          <p>
            This project is not affiliated with, endorsed by, or connected to Uniswap, Aerodrome,
            SushiSwap, BaseSwap, Coinbase or OKX. It reads their public contracts and routes to
            their public routers, which is what those contracts are for. All names are used
            descriptively.
          </p>
          <p className="mt-2">
            It holds no API keys and depends on no commercial data provider. Prices come from
            pool state over public RPC. That is a design constraint, not a cost saving: a router
            whose prices come from an aggregator cannot be checked against that aggregator.
          </p>
        </div>
      </section>
    </>
  );
}
