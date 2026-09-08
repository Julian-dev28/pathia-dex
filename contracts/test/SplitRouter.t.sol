// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {SplitRouter} from "../src/SplitRouter.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract SplitRouterTest is Test {
    address constant UNIV3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    SplitRouter router;
    address trader = address(0xA11CE);
    address attacker = address(0xBAD);

    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }

        address[] memory targets = new address[](2);
        targets[0] = UNIV3_ROUTER;
        targets[1] = AERO_ROUTER;
        router = new SplitRouter(targets);
    }

    /// A split across two fee tiers must settle atomically and pay out at least
    /// what the legs earned, with nothing stranded in the router afterwards.
    function testAtomicSplitPaysOutAndLeavesNothingBehind() public {
        if (!forked) return;

        uint256 amountIn = 10 ether;
        uint256 legA = 6 ether;
        uint256 legB = amountIn - legA;

        deal(WETH, trader, amountIn);

        SplitRouter.Leg[] memory legs = new SplitRouter.Leg[](2);
        legs[0] = SplitRouter.Leg({
            target: UNIV3_ROUTER,
            amountIn: legA,
            data: _v3Call(WETH, USDC, 500, legA, address(router))
        });
        legs[1] = SplitRouter.Leg({
            target: UNIV3_ROUTER,
            amountIn: legB,
            data: _v3Call(WETH, USDC, 3000, legB, address(router))
        });

        // Deltas, not absolutes. On a mainnet fork there is no such thing as
        // an unused address: 0xA11CE already holds 23 USDC on Base, and an
        // assertion against the absolute balance fails by exactly that much
        // while looking like a routing bug.
        uint256 traderBefore = IERC20(USDC).balanceOf(trader);

        vm.startPrank(trader);
        IERC20(WETH).approve(address(router), amountIn);
        uint256 out = router.splitSwap(WETH, USDC, amountIn, 1, trader, legs);
        vm.stopPrank();

        emit log_named_uint("split output", out);

        assertGt(out, 0, "split produced nothing");
        assertEq(
            IERC20(USDC).balanceOf(trader) - traderBefore, out, "trader was not paid the full output"
        );

        // Nothing may outlive the transaction: no dust, and no standing
        // allowance from the router to a venue.
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "input dust stranded in router");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "output dust stranded in router");
        assertEq(IERC20(WETH).balanceOf(trader), 0, "input not fully spent");
        assertEq(IERC20(WETH).allowance(address(router), UNIV3_ROUTER), 0, "allowance left standing");
    }

    /**
     * The attack the allowlist exists to stop.
     *
     * A victim leaves an ERC-20 approval to the router — routine, and the whole
     * point of an approval. The attacker then tries to use the router as a
     * general-purpose call proxy: target the token itself and pass
     * `transferFrom(victim, attacker, allowance)` as the payload. Against an
     * aggregator that forwards arbitrary calls to arbitrary targets, this
     * empties every wallet that has ever approved it, and it has done exactly
     * that in production more than once.
     *
     * Here the token is not an allowlisted target, so the call never happens.
     */
    function testCannotUseRouterAsCallProxyToStealApprovals() public {
        if (!forked) return;

        uint256 victimBalance = 5 ether;
        deal(WETH, trader, victimBalance);

        vm.prank(trader);
        IERC20(WETH).approve(address(router), type(uint256).max);

        SplitRouter.Leg[] memory legs = new SplitRouter.Leg[](1);
        legs[0] = SplitRouter.Leg({
            target: WETH, // the token, not a router
            amountIn: 1,
            data: abi.encodeCall(IERC20.transferFrom, (trader, attacker, victimBalance))
        });

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SplitRouter.NotAllowed.selector, WETH));
        router.splitSwap(WETH, USDC, 1, 0, attacker, legs);

        assertEq(IERC20(WETH).balanceOf(trader), victimBalance, "victim was drained");
        assertEq(IERC20(WETH).balanceOf(attacker), 0, "attacker profited");
    }

    /// Legs must spend exactly what was pulled, or the remainder sits in the
    /// router waiting for the next caller to sweep it.
    function testLegsMustSpendTheWholeInput() public {
        if (!forked) return;

        deal(WETH, trader, 10 ether);

        SplitRouter.Leg[] memory legs = new SplitRouter.Leg[](1);
        legs[0] = SplitRouter.Leg({
            target: UNIV3_ROUTER,
            amountIn: 1 ether,
            data: _v3Call(WETH, USDC, 500, 1 ether, address(router))
        });

        vm.startPrank(trader);
        IERC20(WETH).approve(address(router), 10 ether);
        vm.expectRevert(abi.encodeWithSelector(SplitRouter.AmountMismatch.selector, 1 ether, 10 ether));
        router.splitSwap(WETH, USDC, 10 ether, 1, trader, legs);
        vm.stopPrank();
    }

    /// The minimum-output floor is enforced on the total, not per leg.
    function testRevertsBelowMinimumOutput() public {
        if (!forked) return;

        uint256 amountIn = 1 ether;
        deal(WETH, trader, amountIn);

        SplitRouter.Leg[] memory legs = new SplitRouter.Leg[](1);
        legs[0] = SplitRouter.Leg({
            target: UNIV3_ROUTER,
            amountIn: amountIn,
            data: _v3Call(WETH, USDC, 500, amountIn, address(router))
        });

        vm.startPrank(trader);
        IERC20(WETH).approve(address(router), amountIn);
        // A floor of 1e12 USDC units is a million dollars for one ETH.
        vm.expectRevert();
        router.splitSwap(WETH, USDC, amountIn, 1e12, trader, legs);
        vm.stopPrank();
    }

    function _v3Call(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(
            ISwapRouter02.exactInputSingle,
            (
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            )
        );
    }
}
