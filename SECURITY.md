# Security

## Status

Unaudited. The interface signs mainnet transactions and moves real funds.

## What this project can and cannot do to you

The frontend and the quoting library **never take custody**. Swaps execute
through routers deployed and audited by Uniswap, Aerodrome and the V2 forks.
No approval is granted to any contract belonging to this project, because this
project has no contract deployed. The minimum-output floor is enforced on-chain
by the venue's router.

The realistic worst case from a bug in this repository is a bad quote: the
router recommends a venue that is not the best one, or displays an output the
trade does not achieve. The floor still holds, because the floor is not ours to
break.

`contracts/src/SplitRouter.sol` would take custody mid-trade. It is **not
deployed**, and should not be deployed without an audit.

## Known limitations

- Single-hop routing only; multi-hop liquidity is invisible to the solver.
- Quotes reflect the block they were read at. Between quote and inclusion the
  price can move; that is what the slippage floor is for.
- Transactions go to the public mempool. No private relay, no MEV protection.
- Fee-on-transfer tokens are unsupported and will quote high.
- Public RPC endpoints can be stale or rate-limited. A stale quote produces a
  worse fill, bounded by the floor.

## Reporting

Open an issue for anything that does not involve funds at risk.

For a vulnerability that could cost someone money, do not open a public issue.
Report it privately through GitHub's "Report a vulnerability" on the Security
tab. Include the affected file, the conditions, and what an attacker gains.
Expect an acknowledgement within 72 hours.

Since nothing here is deployed and nothing custodies funds, the plausible
severity ceiling is a mispriced route rather than a loss of principal. A finding
that breaks that assumption is exactly the one worth reporting.
