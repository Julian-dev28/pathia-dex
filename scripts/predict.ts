/**
 * Generates the fixture the fork tests check the router's maths against.
 *
 * The claim this project makes is that its off-chain quote matches what the
 * chain actually pays. That claim is only worth anything if something checks
 * it, so: pin a block, quote every case at that block, write the predictions
 * down, and let Foundry replay each one against a fork of that exact block and
 * compare. A prediction made at `latest` and replayed later is comparing two
 * different markets, which is why the height is part of the fixture.
 *
 *   npm run predict      # writes contracts/test/fixtures/predictions.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { bySymbol } from '../src/lib/chain';
import { client, quoteLadder, ladder, bestRoute, interpolate } from '../src/lib/quote';

const OUT = 'contracts/test/fixtures/predictions.json';

/** Pairs and sizes worth checking: deep and thin, 6-decimal and 18-decimal. */
const CASES: [string, string, string][] = [
  ['WETH', 'USDC', '0.1'],
  ['WETH', 'USDC', '1'],
  ['WETH', 'USDC', '10'],
  ['USDC', 'WETH', '1000'],
  ['USDC', 'WETH', '25000'],
  // DAI on Base is thin: 1 WETH moves it 80%. Sized to a rung the pair can
  // actually absorb, so the test measures the quoter and not the pool.
  ['WETH', 'DAI', '0.05'],
  ['WETH', 'cbBTC', '1'],
  ['USDC', 'DAI', '5000'],
];

// Five blocks back: far enough that the node has settled on it, near enough
// that public RPC still serves the state.
const head = await client().getBlockNumber();
const blockNumber = head - 5n;

console.log(`pinning block ${blockNumber} (head ${head})`);

const cases = [];
for (const [inSym, outSym, amount] of CASES) {
  const tokenIn = bySymbol(inSym);
  const tokenOut = bySymbol(outSym);
  const amountIn = BigInt(Math.round(Number(amount) * 10 ** tokenIn.decimals));

  try {
    const curves = await quoteLadder(tokenIn, tokenOut, ladder(amountIn), undefined, blockNumber);
    if (curves.length === 0) {
      console.log(`  skip ${amount} ${inSym}->${outSym}: no venues`);
      continue;
    }
    const best = bestRoute(curves, amountIn);
    const venue = best.single.allocations[0]?.venue;
    if (!venue) continue;

    cases.push({
      label: `${amount} ${inSym} -> ${outSym}`,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountIn.toString(),
      venueKind: venue.kind,
      venueLabel: venue.label,
      // Everything the Solidity side needs to rebuild the same call. Unused
      // fields are zeroed rather than omitted so the JSON shape is uniform and
      // vm.parseJson does not need a branch per venue kind.
      fee: venue.kind === 'v3' ? venue.fee : 0,
      router: venue.kind === 'v2' ? venue.router : venue.kind === 'aero' ? 'aero' : 'univ3',
      stable: venue.kind === 'aero' ? venue.stable : false,
      predictedOut: best.single.amountOut.toString(),
      predictedSplitOut: best.split.amountOut.toString(),
      splitLegs: best.split.allocations.length,
      edgeBps: best.edgeBps,
    });

    console.log(
      `  ${`${amount} ${inSym}->${outSym}`.padEnd(24)} ${venue.label.padEnd(20)} ` +
        `${interpolate(curves.find((c) => c.venue.id === venue.id)!, amountIn)}`,
    );
  } catch (e) {
    console.log(`  skip ${amount} ${inSym}->${outSym}: ${(e as Error).message.split('\n')[0]}`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      blockNumber: blockNumber.toString(),
      generatedAt: new Date().toISOString(),
      // Solidity cannot ask a JSON array how long it is, so the length is data.
      count: cases.length,
      cases,
    },
    null,
    2,
  ),
);
console.log(`\nwrote ${cases.length} cases to ${OUT}`);
