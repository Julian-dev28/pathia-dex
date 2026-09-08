# Pathia DEX

An on-chain route solver for Base. It quotes every major venue directly from
pool state — direct pools and two-hop routes alike — solves the optimal split
across them, and executes through the venues' own audited routers.

There is no aggregator API anywhere in it, and no API key of any kind. Prices
come from pool reserves and quoter contracts read over public RPC, which is what
makes the central claim checkable: **the router's off-chain quote is compared
against a real fill on a mainnet fork, and has to match.**

```
npm install && npm run dev        # http://localhost:3000
npm run test:unit                 # solver maths, no network
npm run predict                   # quote a set of trades, pin the block
cd contracts && forge test        # replay them on a fork, compare
```

---

## The claim, and the test that checks it

`npm run predict` quotes eleven trades off-chain at a pinned block and writes
down what it expects each to pay. `forge test` forks that exact block, performs
the trades against the deployed Uniswap, Aerodrome and V2-fork routers, and
compares the realised fill to the prediction.

Latest run, Base block 51,038,609 — **every case exact to the wei**:

| Trade | Route | Drift |
| --- | --- | ---: |
| 0.1 WETH → USDC | Uniswap V3 0.01% | 0 bp |
| 1 WETH → USDC | Uniswap V3 0.01% | 0 bp |
| 10 WETH → USDC | Uniswap V3 0.05% | 0 bp |
| 1,000 USDC → WETH | Uniswap V3 0.01% | 0 bp |
| 25,000 USDC → WETH | Uniswap V3 0.05% | 0 bp |
| 0.05 WETH → DAI | **Uniswap V3 via USDC** (2 hops) | 0 bp |
| 1 WETH → cbBTC | Uniswap V3 0.05% | 0 bp |
| 5,000 USDC → DAI | Uniswap V3 0.01% | 0 bp |
| 50,000 DEGEN → USDC | **Uniswap V3 via WETH** (2 hops) | 0 bp |
| 500 AERO → USDC | Uniswap V3 0.05% | 0 bp |
| 10,000 BRETT → WETH | Uniswap V3 1.00% | 0 bp |

Tolerance in the suite is 1bp; measured drift is zero. The multi-hop cases also
validate the path encoder — a packed V3 path this test cannot spend is a path
the app would have signed.

Reproduce with `npm run predict && cd contracts && forge test -vv`. The fixture
pins a block, so regenerate before running: public Base endpoints serve recent
state, not deep history, and a stale fixture skips with a message rather than
failing.

Getting to zero took finding two bugs that both looked like bad arithmetic and
were not:

- **The test contaminated itself.** Cases shared one fork, so an earlier case
  selling 10 WETH into the 0.05% pool left it cheaper for a later case buying
  WETH back. That case came out 11bp *better* than predicted. Each case now runs
  from a snapshot of the pinned block.
- **There are no empty addresses on a mainnet fork.** `0xA11CE` already holds 23
  USDC on Base, so asserting on an absolute balance failed by exactly that
  amount. Assertions are on deltas.

## Multi-hop, and when it matters

A route is a path through one protocol family, not a single pool: `WETH → USDC →
DAI` on Uniswap V3 is one venue with two hops, quoted through `quoteExactInput`
and executed atomically through `exactInput`. Direct and two-hop routes are
therefore interchangeable candidates rather than two separate features, and the
splitter allocates across both.

Candidates are enumerated generously — three V2 forks, Aerodrome's stable and
volatile curves, four V3 fee tiers, each crossed with WETH and USDC as
intermediates — then **pruned before laddering**. Every candidate is quoted once
at full size; only the best six get the full twelve-rung ladder. Laddering the
whole candidate set would be about a hundred and eighty contract calls.

From `npm run bench`, 24 cases across nine pairs:

| Pair | Size | Routes | Best single | Hops | Split legs | Gross | Net of gas | Picks |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| WETH/USDC | 1 | 9 | Uniswap V3 0.01% | 1 | 2 | +0.0 bp | +0.0 bp | single |
| WETH/USDC | 25 | 9 | Uniswap V3 0.05% | 1 | 3 | +3.0 bp | +3.0 bp | split |
| USDC/WETH | 100,000 | 9 | Uniswap V3 0.05% | 1 | 2 | +1.0 bp | +1.0 bp | split |
| WETH/DAI | 0.1 | 12 | **Uniswap V3 via USDC** | 2 | 3 | +0.0 bp | +0.0 bp | single |
| USDC/DAI | 25,000 | 12 | Uniswap V3 0.01% | 1 | 7 | +1256.0 bp | +1256.0 bp | split |
| DEGEN/USDC | 10,000 | 11 | **Uniswap V3 via WETH** | 2 | 5 | +11.0 bp | +7.0 bp | split |
| BRETT/USDC | 200,000 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +17.0 bp | +17.0 bp | split |
| AERO/USDC | 25,000 | 12 | Aerodrome vAMM | 1 | 3 | +0.0 bp | +0.0 bp | single |
| cbETH/USDC | 20 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +1726.0 bp | +1726.0 bp | split |

**Multi-hop was the best route in 8 of 24 cases. Splitting was chosen in 8 of
24, median net edge 7.0bp.**

Three things fall out, and all three are worth saying plainly:

**On deep pairs, splitting is nearly worthless below size.** WETH/USDC under a
few ETH routes to one pool and stays there. A router reporting a win on those
trades is measuring rounding, which is why the recommendation needs a full basis
point of daylight before it switches.

**On long-tail tokens, multi-hop is not an optimisation — it is the only route.**
DEGEN, BRETT and cbETH have no direct USDC pool worth using; every route that
quotes at all passes through WETH. Before multi-hop, this router returned
nothing useful for them.

**The eye-catching numbers are facts about Base's liquidity, not this router's
cleverness.** cbETH/USDC at +1726bp means the direct pools are shallow enough
that spreading the trade is worth seventeen percent. That is a statement about
cbETH on Base.

## How it works

**Discovery.** Nothing is hardcoded but factory addresses. For a pair, the
router asks Uniswap V2, SushiSwap and BaseSwap for their pair, Aerodrome for
both its stable and volatile pool, and lists the V3 fee tiers — then repeats
that through each intermediate. Every address in `src/lib/chain.ts` is checked
for bytecode by `scripts/verify-addresses.sh`, and every token's `symbol()` and
`decimals()` is read from the chain by `npm run verify:tokens`. Both run in CI.
A token entry with the right address and the wrong decimals misprices every
trade in it by a factor of a thousand, silently.

**Quoting.** Constant-product venues are priced off-chain from reserves, with
the fee numerator that fork actually charges — BaseSwap takes 25bp where Uniswap
V2 takes 30. Once reserves are known the whole ladder is arithmetic, multi-hop
included, since a two-hop route is the same function applied twice. All
arithmetic is `bigint`. Aerodrome and Uniswap V3 are quoted on-chain, because a
Solidly stable curve and a concentrated-liquidity tick walk can be reimplemented
off-chain and a reimplementation that drifts by one tick is worse than none.

**Batching.** Everything goes through `Multicall3.aggregate3`, chunked twelve
calls at a time. Chunking is not an optimisation: a V3 quote through a thin pool
walks every initialised tick it crosses and can cost millions of gas, and enough
of those in one batch exceeds the node's `eth_call` gas cap, which rejects the
whole batch rather than the expensive part. WETH/DAI found that.

**Solving.** Each venue is quoted at a geometric ladder of sizes, producing an
output *curve* rather than a number. Because a pool's output is concave in size,
handing each successive slice to whichever venue offers the best marginal rate
converges on the optimum — the water-filling argument. Interpolation between
rungs is piecewise-linear, which on a concave function underestimates: the
solver will never believe a venue is deeper than it is.

**Pricing gas without an oracle.** Comparing a split to a single route needs both
sides in one unit, and the extra cost is in ETH while the benefit is in the token
being bought. Rather than a price feed, the router converts gas through the same
pools it already quoted. The extra-hop cost is 70,000 gas, measured in
`contracts/test/GasProfile.t.sol` as the marginal cost of a second swap.

## Tests

| Suite | What it covers | Network |
| --- | --- | --- |
| `npm run test:unit` | 40 tests: constant-product maths, hop chaining, ladders, interpolation bounds, the splitter, gas-adjusted route choice, slippage floors, path encoding | none |
| `contracts` — `Prediction.t.sol` | Off-chain prediction vs. realised fill, 11 cases, mainnet fork | fork |
| `contracts` — `SplitRouter.t.sol` | Atomic split execution, approval hygiene, the call-proxy exploit | fork |
| `contracts` — `GasProfile.t.sol` | The gas constants the router makes decisions with | fork |
| `scripts/verify-addresses.sh` | Every hardcoded address still has bytecode | RPC |
| `npm run verify:tokens` | Every token's on-chain symbol and decimals | RPC |

The unit tests deliberately use no network. The fork tests prove the quoter
agrees with the chain; the unit tests prove the arithmetic behaves at the edges
the chain rarely visits — empty pools, one-wei trades, ladders that collapse,
curves that are flat. Those are where a router either returns nonsense or
divides by zero.

## Execution and custody

**This project holds nothing.** Swaps go through Uniswap's `SwapRouter02`,
Aerodrome's `Router`, or the V2 forks' routers — all deployed and audited by
their own teams. There is no contract of this project's on mainnet, no approval
is ever granted to it, and the minimum-output floor is enforced on-chain by
those routers rather than by the interface. A bug here costs a user a bad quote,
not their balance.

Approvals are for the exact trade amount, not `type(uint256).max`. Infinite
approval is the convention and it is why a router bug drains wallets months
later.

The interface refuses to sign a quote older than 30 seconds, and requires an
explicit acknowledgement before executing a trade whose price impact is worse
than 3%.

`contracts/src/SplitRouter.sol` is the atomic split executor — the piece that
would let a solved split settle in one transaction. It is written, fork-tested,
and **not deployed**. Shipping an unaudited contract that takes custody mid-trade
to capture seven basis points is a bad trade. It is in the repo to be read.

Its tests include the attack it exists to refuse: a contract that forwards an
arbitrary payload to an arbitrary target is a universal call proxy, and anyone
who has ever approved it can be robbed by passing `target = token` and
`data = transferFrom(victim, attacker, allowance)`. `SplitRouter` allowlists call
targets at construction, so a token address can never be one.

## Serving

Quotes are cached for 3 seconds with request coalescing, so several browsers
asking for the same pair within one block produce one set of RPC calls rather
than several. Rate limiting is 120 requests per minute per IP. Both are
in-process: on serverless each instance keeps its own copy, so the limit is
per-instance rather than global. That defends against a browser hammering the
endpoint on every keystroke, which is the actual failure mode; it is not a
defence against a distributed attacker, and the code says so.

`GET /api/health` reports chain height, block age and RPC latency, and returns
503 when the head goes stale — a health check that only proves the web process
is up was never answering the question.

**On latency.** A cold quote takes 2.4s on a deep pair and about 4s on a
long-tail one. That is three sequential network stages — discovery, then
reserves and pruning together, then the ladder — against a free public endpoint
at roughly 400ms per round trip. Cached repeats are instant. Two rounds of work
went into this (running the gas conversion alongside the ladder instead of
after it, and caching the ETH price rather than rediscovering every route to
compute it) and roughly halved it; the remainder is the public RPC, and the fix
for that is a paid endpoint via `RPC_URL`, not more code.

## Limitations

- **Two hops maximum.** Three-hop routes exist and are not searched.
- **Intermediates are WETH and USDC.** A token paired only against something
  else is invisible to the solver.
- **Execution is single-venue.** The solved split is analysis until the router
  contract is deployed.
- **No MEV protection.** Transactions go to the public mempool. Base's sequencer
  is first-come rather than an auction, which limits sandwiching relative to L1,
  but that is not a guarantee and none is offered.
- **Fee-on-transfer tokens are unsupported.** The quote assumes the amount sent
  is the amount the pool receives.
- **Public RPC rate-limits.** Set `RPC_URL` for anything beyond casual use.
- **Twelve tokens.** Adding more is a line in `src/lib/chain.ts`; discovery does
  not care.

## Layout

```
src/lib/quote.ts        discovery, multi-hop candidates, ladder quoting, the splitter
src/lib/execute.ts      calldata for each venue's router, single and multi-hop
src/lib/gas.ts          gas priced in the output token, no oracle
src/lib/serve.ts        cache with coalescing, rate limit
src/app/api/            quote, venues, health
contracts/src           SplitRouter.sol — written, tested, not deployed
contracts/test          prediction-vs-fill, split router, gas profile
test/solver.test.ts     the maths, no network
scripts/                fixture generation, benchmarks, address and token verification
```

Stack: Next.js, viem, wagmi with injected wallets only — no WalletConnect, which
would put a third-party relay between the user and their signer and require a
project ID this project would then have to hold.

## Independence

Not affiliated with, endorsed by, or connected to Uniswap, Aerodrome, SushiSwap,
BaseSwap, Coinbase or OKX. It reads their public contracts and routes to their
public routers, which is what those contracts are for. All names are used
descriptively.

**Unaudited. Beta.** It moves real money on mainnet. Read the code before you
use it with size.

MIT licensed.
