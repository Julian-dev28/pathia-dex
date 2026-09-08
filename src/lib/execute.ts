/**
 * Turning a chosen route into a transaction.
 *
 * Every path here ends at a router someone else deployed and someone else
 * audited. This project builds calldata; it does not receive tokens, does not
 * hold approvals, and has no contract of its own on mainnet. The consequence
 * worth stating plainly: a bug in this file costs the user a bad fill, not
 * their balance.
 */

import { encodeFunctionData, parseAbi, type Address } from 'viem';
import {
  UNIV3_SWAP_ROUTER,
  AERO_ROUTER,
  AERO_FACTORY,
  type Token,
} from './chain';
import { univ3RouterAbi, aeroRouterAbi, v2RouterAbi, erc20Abi } from './abis';
import type { Venue } from './quote';

const V3R = parseAbi(univ3RouterAbi);
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
  switch (venue.kind) {
    case 'v3':
      return UNIV3_SWAP_ROUTER;
    case 'aero':
      return AERO_ROUTER;
    case 'v2':
      return venue.router;
  }
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
  tokenIn: Token,
  tokenOut: Token,
  amountIn: bigint,
  amountOutMinimum: bigint,
  recipient: Address,
  deadlineSeconds = 600,
): SwapTx {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  switch (venue.kind) {
    case 'v3':
      return {
        to: UNIV3_SWAP_ROUTER,
        data: encodeFunctionData({
          abi: V3R,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: tokenIn.address,
              tokenOut: tokenOut.address,
              fee: venue.fee,
              recipient,
              amountIn,
              amountOutMinimum,
              // No price limit: the minimum-output check is the guard, and a
              // sqrtPrice bound on top of it produces confusing partial-fill
              // reverts for no additional safety.
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
        value: 0n,
      };

    case 'aero':
      return {
        to: AERO_ROUTER,
        data: encodeFunctionData({
          abi: AEROR,
          functionName: 'swapExactTokensForTokens',
          args: [
            amountIn,
            amountOutMinimum,
            [
              {
                from: tokenIn.address,
                to: tokenOut.address,
                stable: venue.stable,
                factory: AERO_FACTORY,
              },
            ],
            recipient,
            deadline,
          ],
        }),
        value: 0n,
      };

    case 'v2':
      return {
        to: venue.router,
        data: encodeFunctionData({
          abi: V2R,
          functionName: 'swapExactTokensForTokens',
          args: [
            amountIn,
            amountOutMinimum,
            [tokenIn.address, tokenOut.address],
            recipient,
            deadline,
          ],
        }),
        value: 0n,
      };
  }
}
