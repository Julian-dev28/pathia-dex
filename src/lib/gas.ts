/**
 * Pricing gas in the output token, without a price API.
 *
 * Comparing a split route to a single route requires both sides in the same
 * unit, and the extra cost of splitting is denominated in ETH while the benefit
 * is denominated in whatever you are buying. The usual fix is a price oracle or
 * a CoinGecko key. Neither is necessary: the pools we already quote against are
 * themselves the ETH price. We ask them what the gas is worth.
 */

import { type Token, WETH } from './chain';
import { client, quoteLadder, interpolate } from './quote';

/**
 * Gas for one *additional* pool hop — the marginal cost of splitting, not the
 * cost of a whole swap.
 *
 * Measured at 69,589 in contracts/test/GasProfile.t.sol as the second of two
 * swaps on a mainnet fork; the first pays one-off warming costs the second does
 * not, and charging the full 105k to every extra leg made splits look ~50k gas
 * worse than they are. Rounded up to 70,000.
 */
export const GAS_PER_EXTRA_HOP = 70_000n;

export async function gasPriceWei(): Promise<bigint> {
  try {
    return await client().getGasPrice();
  } catch {
    // Base is an L2 with a fee floor around 0.01 gwei; if the endpoint is
    // unreachable, a stale-but-plausible number beats failing the whole quote.
    return 10_000_000n;
  }
}

/**
 * What one extra hop costs, expressed in `tokenOut` base units.
 *
 * Returns 0n when the conversion cannot be made — a missing WETH pair for an
 * exotic token — which makes the gas adjustment a no-op rather than a wrong
 * number. Callers see the pre-gas comparison in that case, and the UI says so.
 */
export async function hopCostInToken(tokenOut: Token, gasWei?: bigint): Promise<bigint> {
  const price = gasWei ?? (await gasPriceWei());
  const costWei = price * GAS_PER_EXTRA_HOP;
  if (costWei <= 0n) return 0n;

  if (tokenOut.address.toLowerCase() === WETH.address.toLowerCase()) return costWei;

  try {
    const curves = await quoteLadder(WETH, tokenOut, [costWei * 1000n]);
    if (curves.length === 0) return 0n;
    const best = curves.reduce((a, b) =>
      interpolate(b, costWei * 1000n) > interpolate(a, costWei * 1000n) ? b : a,
    );
    // Quoted 1000x the gas amount because a few cents of ETH rounds to zero
    // output on a 6-decimal token; scale the answer back down.
    return interpolate(best, costWei * 1000n) / 1000n;
  } catch {
    return 0n;
  }
}
