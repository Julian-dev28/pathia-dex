# base·router

An on-chain route solver for Base. It quotes every major venue directly from
pool state, solves the optimal split across them, and executes through the
venues' own audited routers.

There is no aggregator API anywhere in it, and no API key of any kind. Prices
come from pool reserves and quoter contracts read over public RPC, which is what
makes the central claim checkable: **the router's off-chain quote is compared
against a real fill on a mainnet fork, and has to match.**

```
npm install && npm run dev        # http://localhost:3000
npm run predict                   # quote a set of trades, pin the block
cd contracts && forge test        # replay them on a fork, compare
```

---

## The claim, and the test that checks it

`npm run predict` quotes eight trades off-chain at a pinned block and writes down
what it expects each to pay. `forge test` forks that exact block, performs the
trades against the deployed Uniswap, Aerodrome and V2-fork routers, and compares
the realised fill to the prediction.

Latest run, Base block 51,036,314 — every case exact to the wei:

| Trade | Predicted | Realised | Drift |
| --- | ---: | ---: | ---: |
| 0.1 WETH → USDC | 248,833,078 | 248,833,078 | 0 bp |
| 1 WETH → USDC | 2,487,537,234 | 2,487,537,234 | 0 bp |
| 10 WETH → USDC | 24,864,020,621 | 24,864,020,621 | 0 bp |
| 1,000 USDC → WETH | 401,705,369,129,648,106 | 401,705,369,129,648,106 | 0 bp |
| 25,000 USDC → WETH | 10,034,431,085,741,909,451 | 10,034,431,085,741,909,451 | 0 bp |
| 0.05 WETH → DAI | 122,367,191,950,257,973,247 | 122,367,191,950,257,973,247 | 0 bp |
| 1 WETH → cbBTC | 3,160,805 | 3,160,805 | 0 bp |
| 5,000 USDC → DAI | 5,001,010,018,309,999,894,794 | 5,001,010,018,309,999,894,794 | 0 bp |

Tolerance in the suite is 1bp; the measured drift is zero. Reproduce with
`npm run predict && cd contracts && forge test -vv`. The fixture pins a block,
so regenerate it before running — public Base endpoints serve recent state, not
deep history, and a stale fixture skips with a message rather than failing.

Getting to zero took finding two bugs that both looked like bad arithmetic and
were not:

- **The test contaminated itself.** Cases shared one fork, so an earlier case
  selling 10 WETH into the 0.05% pool left it cheaper for a later case buying
  WETH back. That case came out 11bp *better* than predicted. Each case now runs
  from a snapshot of the pinned block.
- **There are no empty addresses on a mainnet fork.** `0xA11CE` already holds 23
  USDC on Base, so asserting on an absolute balance failed by exactly that
  amount. Assertions are on deltas.

## When splitting actually pays

Every aggregator splits. The question worth measuring is at what size splitting
starts to earn more than the extra hop costs. `npm run bench` sweeps pairs across
a ladder of sizes and reports the split's edge over the best single venue, gross
and net of gas:

| Pair | Size | Venues | Best single | Legs | Gross | Net of gas | Picks |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| WETH/USDC | 0.1 | 9 | Uniswap V3 0.01% | 1 | +0.0 bp | +0.0 bp | single |
| WETH/USDC | 1 | 9 | Uniswap V3 0.01% | 1 | +0.0 bp | +0.0 bp | single |
| WETH/USDC | 5 | 9 | Uniswap V3 0.05% | 2 | +1.0 bp | +1.0 bp | split |
| WETH/USDC | 25 | 9 | Uniswap V3 0.05% | 2 | +1.0 bp | +1.0 bp | split |
| WETH/USDC | 100 | 9 | Uniswap V3 0.30% | 3 | +5.0 bp | +5.0 bp | split |
| USDC/WETH | 100,000 | 9 | Uniswap V3 0.05% | 3 | +4.0 bp | +4.0 bp | split |
| WETH/cbBTC | 10 | 7 | Uniswap V3 0.05% | 1 | +0.0 bp | +0.0 bp | single |
| USDC/DAI | 25,000 | 8 | Uniswap V3 0.01% | 3 | +912.0 bp | +912.0 bp | split |
| WETH/DAI | 0.1 | 9 | Uniswap V3 0.30% | 4 | +562.0 bp | +562.0 bp | split |

Split chosen in 6 of 16 cases; median net edge when it splits, 5.0bp.

Two things fall out of this, and both are worth saying plainly:

**On deep pairs, splitting is nearly worthless below size.** WETH/USDC under a
few ETH routes to one pool and stays there. A router that reports a win on those
trades is measuring rounding.

**On thin pairs it is the whole game.** DAI on Base is shallow enough that 0.1
WETH moves it several percent, and spreading that across four pools is worth
hundreds of basis points. The eye-catching numbers in this table are a fact
about DAI's liquidity on Base, not a claim about this router's cleverness.

The recommendation needs a full basis point of daylight before it switches to a
split — beating a single venue by a fraction of a basis point buys nothing and
costs an extra pool's worth of execution risk.

## How it works

**Discovery.** Nothing is hardcoded but factory addresses. For a pair, the router
asks Uniswap V2, SushiSwap and BaseSwap for their pair, Aerodrome for both its
stable and volatile pool, and lists all four Uniswap V3 fee tiers; empty tiers
revert at quote time and drop out. Every address in `src/lib/chain.ts` is checked
for bytecode by `scripts/verify-addresses.sh`, which runs in CI.

**Quoting.** Constant-product venues are priced off-chain from reserves, using
the fee numerator that fork actually charges — BaseSwap takes 25bp where Uniswap
V2 takes 30, and one shared constant mis-prices every BaseSwap trade. All
arithmetic is `bigint`. Aerodrome and Uniswap V3 are quoted on-chain, because a
Solidly stable curve and a concentrated-liquidity tick walk can be reimplemented
off-chain and a reimplementation that drifts by one tick is worse than none.

**Batching.** Every venue at every size goes out through `Multicall3.aggregate3`,
chunked twelve calls at a time. Chunking is not an optimisation: a V3 quote
through a thin pool walks every initialised tick it crosses and can cost millions
of gas, and enough of those in one batch exceeds the node's `eth_call` gas cap,
which rejects the whole batch rather than the expensive part. WETH/DAI found
that.

**Solving.** Each venue is quoted at a geometric ladder of sizes, producing an
output *curve* rather than a number. Because a pool's output is concave in size,
handing each successive slice to whichever venue offers the best marginal rate
converges on the optimum — the water-filling argument. Interpolation between
rungs is piecewise-linear, which on a concave function underestimates: the solver
will never believe a venue is deeper than it is.

**Pricing gas without an oracle.** Comparing a split to a single route needs both
sides in one unit, and the extra cost is in ETH while the benefit is in the token
being bought. Rather than a price feed, the router converts gas through the same
pools it already quoted. The extra-hop cost is 70,000 gas, measured in
`contracts/test/GasProfile.t.sol` as the marginal cost of a second swap — the
first pays warming costs the second does not, and charging a full swap to every
extra leg made splits look 50k gas worse than they are.

## Execution and custody

**This project holds nothing.** Swaps go through Uniswap's `SwapRouter02`,
Aerodrome's `Router`, or the V2 forks' routers — all deployed and audited by
their own teams. There is no contract of this project's on mainnet, no approval
is ever granted to it, and the minimum-output floor is enforced on-chain by those
routers rather than by the interface. A bug here costs a user a bad quote, not
their balance.

Approvals are for the exact trade amount, not `type(uint256).max`. Infinite
approval is the convention and it is why a router bug drains wallets months
later.

`contracts/src/SplitRouter.sol` is the atomic split executor — the piece that
would let a solved split settle in one transaction. It is written, fork-tested,
and **not deployed**. Shipping an unaudited contract that takes custody mid-trade
to capture five basis points is a bad trade. It is in the repo to be read.

Its tests include the attack it exists to refuse: a contract that forwards an
arbitrary payload to an arbitrary target is a universal call proxy, and anyone
who has ever approved it can be robbed by passing `target = token` and
`data = transferFrom(victim, attacker, allowance)`. `SplitRouter` allowlists call
targets at construction, so a token address can never be one.

## Limitations

- **Single-hop only.** Routes go A→B directly. A pair whose real liquidity runs
  A→WETH→B is underquoted here, and a multi-hop aggregator will beat it there.
- **Execution is single-venue.** The solved split is analysis until the router
  contract is deployed.
- **No MEV protection.** Transactions go to the public mempool. Base's sequencer
  is first-come rather than an auction, which limits sandwiching relative to L1,
  but that is not a guarantee and none is offered.
- **Fee-on-transfer tokens are unsupported.** The quote assumes the amount sent
  is the amount the pool receives.
- **Public RPC rate-limits.** Set `RPC_URL` for anything beyond casual use.
- **Four tokens.** WETH, USDC, cbBTC, DAI. Adding more is a line in
  `src/lib/chain.ts`; the discovery path does not care.

## Layout

```
src/lib/quote.ts        discovery, ladder quoting, the split solver
src/lib/execute.ts      calldata for each venue's router
src/lib/gas.ts          gas priced in the output token, no oracle
src/app/api/quote       server-side quoting (public RPC rate limits)
contracts/src           SplitRouter.sol — written, tested, not deployed
contracts/test          prediction-vs-fill, split router, gas profile
scripts/predict.ts      generates the fork-test fixture
scripts/bench.ts        generates the table above
```

Stack: Next.js, viem, wagmi with injected wallets only — no WalletConnect, which
would put a third-party relay between the user and their signer and require a
project ID this project would then have to hold.

## Independence

Not affiliated with, endorsed by, or connected to Uniswap, Aerodrome, SushiSwap,
BaseSwap, Coinbase or OKX. It reads their public contracts and routes to their
public routers, which is what those contracts are for. All names are used
descriptively.

**Unaudited. Beta.** It moves real money on mainnet. Read the code before you use
it with size.

MIT licensed.
