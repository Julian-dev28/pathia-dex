export const metadata = { title: 'Method — base·router' };

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
              and volatile pool, and lists all four Uniswap V3 fee tiers. Tiers with no pool
              revert at quote time and drop out on their own.
            </p>
            <p className="mt-2">
              Every address in <code className="mono">src/lib/chain.ts</code> is checked for
              bytecode by <code className="mono">scripts/verify-addresses.sh</code>, which runs in
              CI. A wrong address is the cheapest possible bug and the cheapest possible test.
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
                <td>Single-hop only</td>
                <td>
                  Routes go A→B directly. A pair whose real liquidity is A→WETH→B will be
                  underquoted here, and an aggregator with multi-hop will beat it on those pairs.
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
