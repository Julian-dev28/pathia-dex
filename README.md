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

Latest run — 13 cases, **every one exact to the wei**:

| Trade | Route | Drift |
| --- | --- | ---: |
| 0.1 WETH → USDC | PancakeSwap V3 0.01% | 0 bp |
| 1 WETH → USDC | Uniswap V3 0.05% | 0 bp |
| 10 WETH → USDC | Uniswap V3 0.05% | 0 bp |
| 1,000 USDC → WETH | PancakeSwap V3 0.01% | 0 bp |
| 25,000 USDC → WETH | PancakeSwap V3 0.01% | 0 bp |
| 0.05 WETH → DAI | **Uniswap V3 via USDC** (2 hops) | 0 bp |
| 1 WETH → cbBTC | Uniswap V3 0.30% | 0 bp |
| 5,000 USDC → DAI | Uniswap V3 0.01% | 0 bp |
| 50,000 DEGEN → USDC | **Uniswap V3 via WETH** (2 hops) | 0 bp |
| 500 AERO → USDC | Uniswap V3 0.05% | 0 bp |
| 10,000 BRETT → WETH | Uniswap V3 0.30% | 0 bp |
| 2 WETH → USDC | PancakeSwap V3 0.01% *(forced)* | 0 bp |
| 0.5 cbBTC → USDC | PancakeSwap V3 0.01% *(forced)* | 0 bp |

Two cases are *forced* onto PancakeSwap rather than taking the best route.
Without that, fork coverage is whatever happened to win on the day, and
PancakeSwap's execution path is precisely the one that would silently revert —
see below.

Tolerance in the suite is 1bp; measured drift is zero. The multi-hop cases also
validate the path encoder — a packed V3 path this test cannot spend is a path
the app would have signed.

Reproduce with `npm run predict && cd contracts && forge test -vv`. The fixture
pins a block, so regenerate before running: public Base endpoints serve recent
state, not deep history, and a stale fixture skips with a message rather than
failing.

Getting to zero took finding three bugs that all looked like something else:

- **The test contaminated itself.** Cases shared one fork, so an earlier case
  selling 10 WETH into the 0.05% pool left it cheaper for a later case buying
  WETH back. That case came out 11bp *better* than predicted. Each case now runs
  from a snapshot of the pinned block.
- **There are no empty addresses on a mainnet fork.** `0xA11CE` already holds 23
  USDC on Base, so asserting on an absolute balance failed by exactly that
  amount. Assertions are on deltas.
- **PancakeSwap's router is not Uniswap's router.** It forked Uniswap's
  *original* `SwapRouter`, whose swap params carry a `deadline`; Uniswap moved
  to `SwapRouter02`, which does not. Same function names, different structs,
  different selectors — and encoding one against the other reverts every swap
  on that venue. Caught by reading the selectors out of the deployed bytecode
  (`npm run probe:venues`) before writing a line of integration, and now
  recorded as `routerHasDeadline` in the deployment table.

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
| WETH/USDC | 1 | 9 | PancakeSwap V3 0.01% | 1 | 2 | +0.0 bp | +0.0 bp | single |
| WETH/USDC | 25 | 9 | PancakeSwap V3 0.01% | 1 | 4 | +4.0 bp | +4.0 bp | split |
| USDC/WETH | 100,000 | 9 | PancakeSwap V3 0.01% | 1 | 3 | +9.0 bp | +9.0 bp | split |
| WETH/cbBTC | 10 | 11 | PancakeSwap V3 0.01% | 1 | 3 | +0.0 bp | +0.0 bp | single |
| WETH/DAI | 0.1 | 12 | **Uniswap V3 via USDC** | 2 | 4 | +0.0 bp | +0.0 bp | single |
| USDC/DAI | 25,000 | 12 | Uniswap V3 0.01% | 1 | 4 | +3234.0 bp | +3234.0 bp | split |
| DEGEN/USDC | 10,000 | 11 | **Aerodrome v/s via WETH** | 2 | 5 | +5.0 bp | +1.0 bp | split |
| BRETT/USDC | 200,000 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +18.0 bp | +18.0 bp | split |
| AERO/USDC | 25,000 | 12 | Aerodrome vAMM | 1 | 4 | +0.0 bp | +0.0 bp | single |
| cbETH/USDC | 20 | 11 | **Uniswap V3 via WETH** | 2 | 2 | +1727.0 bp | +1727.0 bp | split |

**Multi-hop was the best route in 8 of 24 cases. PancakeSwap V3 was the best
single venue in 10 of 24. Splitting was chosen in 10 of 24, median net edge
4.0bp.**

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

## Adding venues, and which ones are worth adding

Every venue below is free: public contracts, public RPC, no key, no
registration. What separates them is whether they hold liquidity worth routing
to, which is a question you answer by measuring, not by counting integrations.
`npm run probe:venues` does the measuring — it reads reserves, asks each fork's
own router what it would pay, and **derives the fee from the two** rather than
trusting a constant.

**Added: PancakeSwap V3.** Its 0.01% tier prices better than anything else on
Base for mid-size WETH/USDC. After adding it, it is the best single venue in 10
of the 24 benchmark cases — one free venue changed the winner on 42% of them.
Its fee tiers are not Uniswap's either: 0.25% where Uniswap has 0.30%.

**Rejected: the V2 forks.** PancakeSwap V2, AlienBase and SwapBased all have
live WETH/USDC pairs. They hold 0.2, 0.1 and 0.5 WETH respectively — a few
hundred dollars each. They would never win a route, and each one costs a
discovery call on every quote. Measured and left out; the probe script keeps the
evidence.

**Quotable but not yet executable: Uniswap V4.** V4 is live on Base and quotes
competitively (the hookless 0.30%/60 pool prices within a few bp of V3). It has
no factory — a pool is identified by its key, so discovery means enumerating
`(fee, tickSpacing, hooks)` and letting the quoter revert on the rest, which
works for hookless pools and cannot enumerate hooked ones at all. The blocker is
execution: V4 settles through `UniversalRouter` with Permit2 and an encoded
action sequence, not a router call. Quoting a venue this app cannot execute
would break the rule the rest of it follows, so V4 stays out until the execution
path is written. The probe script quotes it today.

**Not viable: the OKX repos.** Checked all five:

| Repo | What it actually is | Verdict |
| --- | --- | --- |
| `Web3-DEX-EVM-PMM` | RFQ onboarding for *private market makers* — you supply signed `OrderRFQ` quotes | Requires being an onboarded PMM counterparty. No public liquidity. |
| `Web3-DEX-evm-intent-sdk` | Calldata builder for `Settlement.settle()` | Requires being a solver in their auction. |
| `Web3-DEX-Router-EVM-V1` | The DexRouter contracts. Deployed on Base at `0x4409921a…`, exposing `smartSwapByOrderId` | Callable, but it is an *executor with no liquidity of its own*. Routing through it reaches the same Uniswap and Aerodrome pools this app already calls directly, plus a hop, plus its commission. |
| `Web3-DEX-Router-Solana-V1` | Anchor programs | Solana. Different chain. |
| `web3-solana-rfq-v2` | — | **404. The repository does not exist.** |

None of them offer a free liquidity source for a Base router. Two are
permissioned-counterparty infrastructure, one is a different chain, one is a
pass-through executor, and one is not there. The OKX *aggregator API* would give
routes, but it needs credentials, which is the dependency this project exists to
avoid.

## How it works

**Discovery.** Nothing is hardcoded but factory addresses. For a pair, the
router asks Uniswap V2, SushiSwap and BaseSwap for their pair, Aerodrome for
both its stable and volatile pool, and lists the fee tiers of each
concentrated-liquidity deployment — Uniswap V3 and PancakeSwap V3 — then repeats
that through each intermediate. A V3 fork is a row in a table, not a code path. Every address in `src/lib/chain.ts` is checked
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
| `npm run probe:venues` | Candidate venues: liquidity, derived fees, router selectors | RPC |

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
- **No Uniswap V4.** Quotable today and measured by `npm run probe:venues`, but
  it settles through `UniversalRouter` with Permit2 rather than a router call,
  and this app does not quote what it cannot execute.
- **Hooked V4 pools are unenumerable by design.** Even with V4 execution, a pool
  behind an arbitrary hook address cannot be discovered by guessing keys.

## Layout

```
src/lib/quote.ts        discovery, multi-hop candidates, ladder quoting, the splitter
src/lib/chain.ts        every address, every venue, as data — V2 forks and V3 deployments
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
