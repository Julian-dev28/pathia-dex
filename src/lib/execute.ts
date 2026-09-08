/**
 * Turning a chosen route into a transaction.
 *
 * Every path here ends at a router someone else deployed and someone else
 * audited. This project builds calldata; it does not receive tokens, does not
 * hold approvals, and has no contract of its own on mainnet. The consequence
 * worth stating plainly: a bug in this file costs the user a bad fill, not
 * their balance.
 *
 * Multi-hop routes settle atomically — Uniswap V3 through `exactInput` with a
 * packed path, the V2 forks and Aerodrome through their multi-element path and
 * route arguments. There is no version of this that sends two transactions and
 * hopes; a partially executed route leaves the user holding an intermediate
 * token they never asked for.
 */

import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { AERO_ROUTER, AERO_FACTORY, V3_DEPLOYMENTS, type Token } from './chain';
import {
  univ3RouterAbi,
  v3RouterWithDeadlineAbi,
  aeroRouterAbi,
  v2RouterAbi,
  erc20Abi,
} from './abis';
import { encodeV3Path, type Venue, type Hop } from './quote';

const V3R = parseAbi(univ3RouterAbi);
const V3R_DEADLINE = parseAbi(v3RouterWithDeadlineAbi);
const AEROR = parseAbi(aeroRouterAbi);
const V2R = parseAbi(v2RouterAbi);
export const ERC20 = parseAbi(erc20Abi);

export type SwapTx = { to: Address; data: `0x${string}`; value: bigint };

/**
 * Apply slippage tolerance to a quote.
 *
 * Integer basis points, floor division: the user's floor is always at or below
 * the number shown, never above it by a rounding error. `quotedOut` is what the
 * chain said a moment ago, so this is the only thing standing between the user
 * and an adverse move between quote and inclusion.
 */
export function minOut(quotedOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5_000, Math.round(slippageBps))));
  return (quotedOut * (10_000n - bps)) / 10_000n;
}

/** The router that will pull the input token, i.e. the address to approve. */
export function spenderFor(venue: Venue): Address {
  if (venue.family === 'aero') return AERO_ROUTER;
  if (!venue.router) throw new Error(`venue ${venue.id} has no router`);
  return venue.router;
}

/**
 * Approve exactly the amount being spent, not `type(uint256).max`.
 *
 * Infinite approval is the convention and it is the reason a router bug or a
 * phished signature drains a wallet months later. An exact approval costs one
 * extra transaction per trade and bounds the loss to the trade itself.
 */
export function approveTx(token: Token, spender: Address, amount: bigint): SwapTx {
  return {
    to: token.address,
    data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] }),
    value: 0n,
  };
}

export function buildSwap(
  venue: Venue,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: Address,
  deadlineSeconds = 600,
): SwapTx {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
  const path = venue.path;

  switch (venue.family) {
    case 'v3': {
      const v3hops = venue.hops as Extract<Hop, { family: 'v3' }>[];
      const fees = v3hops.map((h) => h.fee);
      const dep = V3_DEPLOYMENTS[v3hops[0].dex];
      const router = dep.router;
      const single = venue.hops.length === 1;

      // PancakeSwap forked Uniswap's original SwapRouter, whose params carry a
      // deadline; Uniswap's SwapRouter02 does not. Same function name,
      // different struct, different selector. Encoding the wrong one does not
      // fail gracefully — it reverts every swap on that venue.
      if (dep.routerHasDeadline) {
        return {
          to: router,
          data: single
            ? encodeFunctionData({
                abi: V3R_DEADLINE,
                functionName: 'exactInputSingle',
                args: [
                  {
                    tokenIn: path[0].address,
                    tokenOut: path[1].address,
                    fee: fees[0],
                    recipient,
                    deadline,
                    amountIn,
                    amountOutMinimum,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              })
            : encodeFunctionData({
                abi: V3R_DEADLINE,
                functionName: 'exactInput',
                args: [
                  {
                    path: encodeV3Path(path, fees),
                    recipient,
                    deadline,
                    amountIn,
                    amountOutMinimum,
                  },
                ],
              }),
          value: 0n,
        };
      }

      return {
        to: router,
        data: single
          ? encodeFunctionData({
              abi: V3R,
              functionName: 'exactInputSingle',
              args: [
                {
                  tokenIn: path[0].address,
                  tokenOut: path[1].address,
                  fee: fees[0],
                  recipient,
                  amountIn,
                  amountOutMinimum,
                  // No price limit: the minimum-output check is the guard, and
                  // a sqrtPrice bound on top of it produces confusing
                  // partial-fill reverts for no additional safety.
                  sqrtPriceLimitX96: 0n,
                },
              ],
            })
          : encodeFunctionData({
              abi: V3R,
              functionName: 'exactInput',
              args: [
                {
                  path: encodeV3Path(path, fees),
                  recipient,
                  amountIn,
                  // The floor applies to the end of the path, not to each hop.
                  amountOutMinimum,
                },
              ],
            }),
        value: 0n,
      };
    }

    case 'aero':
      return {
        to: AERO_ROUTER,
        data: encodeFunctionData({
          abi: AEROR,
          functionName: 'swapExactTokensForTokens',
          args: [
            amountIn,
            amountOutMinimum,
            venue.hops.map((h, i) => ({
              from: path[i].address,
              to: path[i + 1].address,
              stable: (h as Extract<Hop, { family: 'aero' }>).stable,
              factory: AERO_FACTORY,
            })),
            recipient,
            deadline,
          ],
        }),
        value: 0n,
      };

    case 'v2':
      return {
        to: spenderFor(venue),
        data: encodeFunctionData({
          abi: V2R,
          functionName: 'swapExactTokensForTokens',
          args: [amountIn, amountOutMinimum, path.map((t) => t.address), recipient, deadline],
        }),
        value: 0n,
      };
  }
}
