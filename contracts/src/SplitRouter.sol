// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title SplitRouter
 * @notice Executes one trade across several venues atomically, so a split
 *         solved off-chain settles at one price instead of as a sequence of
 *         separate transactions that each move the market for the next.
 *
 * @dev NOT DEPLOYED. This contract exists to be read and fork-tested. The
 *      interface it presents — take user funds, call other people's routers —
 *      is the single most attacked shape in DeFi, and shipping it unaudited to
 *      capture a basis point would be a bad trade. See test/SplitRouter.t.sol
 *      for the exploit it is built to refuse.
 *
 *      The vulnerability worth naming, because it has drained several real
 *      aggregators: a contract that forwards an arbitrary `data` payload to an
 *      arbitrary `target` is a universal call proxy. Any user who has ever left
 *      an ERC-20 allowance to it can be robbed by anyone, simply by passing
 *      `target = token` and `data = transferFrom(victim, attacker, allowance)`.
 *      The contract's own balance is irrelevant; the approvals pointed at it
 *      are the honeypot.
 *
 *      Two properties defend against that here:
 *
 *      1. `target` must be in an immutable allowlist fixed at construction.
 *         A token address can never be a call target, so `transferFrom` can
 *         never be reached through this contract.
 *      2. Approvals granted to venue routers are set to the exact leg amount
 *         and zeroed after the call, so nothing outlives the transaction.
 *
 *      Neither is novel. Both are omitted often enough to be worth stating.
 */
contract SplitRouter {
    error NotAllowed(address target);
    error LegFailed(uint256 index);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error AmountMismatch(uint256 sumOfLegs, uint256 declared);
    error NoLegs();

    /// @notice Venue routers this contract may call. Fixed at construction.
    mapping(address => bool) public allowedTarget;

    /// @param targets The venue routers to permit — Uniswap's SwapRouter02,
    ///        Aerodrome's Router, and the V2 fork routers. Immutable in effect:
    ///        there is no setter, and no owner to call one.
    constructor(address[] memory targets) {
        for (uint256 i = 0; i < targets.length; i++) {
            allowedTarget[targets[i]] = true;
        }
    }

    /// @param target Venue router to call. Must be allowlisted.
    /// @param amountIn Portion of the trade routed through this venue.
    /// @param data Encoded swap call. Its recipient must be this contract, so
    ///        the final minimum-output check sees every leg's proceeds.
    struct Leg {
        address target;
        uint256 amountIn;
        bytes data;
    }

    /**
     * @notice Pull `amountIn` of `tokenIn`, route it through `legs`, and send
     *         at least `minAmountOut` of `tokenOut` to `recipient`.
     * @dev Output is measured as this contract's balance delta rather than
     *      taken from any leg's return value: a venue that reports one number
     *      and transfers another cannot inflate the total, and the check holds
     *      even for a router whose return type we did not anticipate.
     */
    function splitSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        Leg[] calldata legs
    ) external returns (uint256 amountOut) {
        if (legs.length == 0) revert NoLegs();

        uint256 declared;
        for (uint256 i = 0; i < legs.length; i++) {
            if (!allowedTarget[legs[i].target]) revert NotAllowed(legs[i].target);
            declared += legs[i].amountIn;
        }
        // The legs must spend exactly what was pulled. Without this, a caller
        // could pull 10 ETH, route 1, and leave 9 sitting here for the next
        // transaction to sweep.
        if (declared != amountIn) revert AmountMismatch(declared, amountIn);

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        for (uint256 i = 0; i < legs.length; i++) {
            IERC20(tokenIn).approve(legs[i].target, legs[i].amountIn);
            (bool ok,) = legs[i].target.call(legs[i].data);
            if (!ok) revert LegFailed(i);
            // Zero the approval even on success: a router that pulled less than
            // it was offered would otherwise leave a standing allowance.
            IERC20(tokenIn).approve(legs[i].target, 0);
        }

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}
