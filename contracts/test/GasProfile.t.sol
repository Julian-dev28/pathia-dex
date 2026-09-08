// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

interface IERC20 {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
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

interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(uint256, uint256, Route[] calldata, address, uint256)
        external
        returns (uint256[] memory);
}

interface IV2Router {
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external
        returns (uint256[] memory);
}

/**
 * Where the gas constants in the TypeScript come from.
 *
 * `src/lib/quote.ts` charges a V2 swap 102k gas and `src/lib/gas.ts` charges an
 * extra split hop 70k, and those numbers decide whether the router recommends
 * splitting a trade. A guessed constant there is a thumb on the scale of every
 * routing decision the product makes, so they are measured against the real
 * routers here and the test fails if reality drifts away from them.
 *
 * Uniswap V3 is excluded from the assertions: its cost depends on how many
 * initialised ticks the swap crosses, which is a property of the trade and not
 * of the venue, so the router uses the quoter's own per-quote gas estimate
 * there rather than a constant.
 */
contract GasProfileTest is Test {
    address constant UNIV3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// The constants under test, mirrored from the TypeScript.
    uint256 constant V2_GAS_ASSUMED = 102_000;
    uint256 constant EXTRA_HOP_ASSUMED = 70_000;

    /// Generous, because gas moves with pool state and warm/cold storage. The
    /// test exists to catch a constant that is wrong by a factor, not one that
    /// is wrong by a few thousand.
    uint256 constant SLACK = 60_000;

    address trader = address(0xF00D);
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {}
    }

    function testV2SwapGasMatchesAssumption() public {
        if (!forked) return;

        uint256 amountIn = 0.05 ether;
        deal(WETH, trader, amountIn);

        vm.startPrank(trader);
        IERC20(WETH).approve(UNIV2_ROUTER, amountIn);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = USDC;

        uint256 before = gasleft();
        IV2Router(UNIV2_ROUTER).swapExactTokensForTokens(
            amountIn, 0, path, trader, block.timestamp + 600
        );
        uint256 used = before - gasleft();
        vm.stopPrank();

        emit log_named_uint("Uniswap V2 swap gas", used);
        assertApproxEqAbs(used, V2_GAS_ASSUMED, SLACK, "V2 gas constant has drifted");
    }

    function testAerodromeSwapGas() public {
        if (!forked) return;

        uint256 amountIn = 0.05 ether;
        deal(WETH, trader, amountIn);

        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: WETH, to: USDC, stable: false, factory: AERO_FACTORY});

        vm.startPrank(trader);
        IERC20(WETH).approve(AERO_ROUTER, amountIn);
        uint256 before = gasleft();
        IAeroRouter(AERO_ROUTER).swapExactTokensForTokens(
            amountIn, 0, routes, trader, block.timestamp + 600
        );
        uint256 used = before - gasleft();
        vm.stopPrank();

        emit log_named_uint("Aerodrome swap gas", used);
        assertLt(used, 400_000, "Aerodrome swap is far more expensive than assumed");
    }

    /**
     * The number that decides whether splitting is worth it: what a second
     * venue costs on top of the first. Measured as the marginal cost of the
     * second of two swaps, since the first pays one-off warming costs the
     * second does not.
     */
    function testExtraHopMarginalGas() public {
        if (!forked) return;

        uint256 amountIn = 0.05 ether;
        deal(WETH, trader, amountIn * 2);

        vm.startPrank(trader);
        IERC20(WETH).approve(UNIV3_ROUTER, amountIn * 2);

        uint256 g0 = gasleft();
        _v3(amountIn, 500);
        uint256 first = g0 - gasleft();

        uint256 g1 = gasleft();
        _v3(amountIn, 3000);
        uint256 second = g1 - gasleft();
        vm.stopPrank();

        emit log_named_uint("first hop gas", first);
        emit log_named_uint("second hop gas", second);
        emit log_named_uint("assumed extra hop", EXTRA_HOP_ASSUMED);

        assertLt(
            second,
            EXTRA_HOP_ASSUMED + SLACK,
            "extra-hop constant understates the real cost, so splits look cheaper than they are"
        );
    }

    function _v3(uint256 amountIn, uint24 fee) internal {
        ISwapRouter02(UNIV3_ROUTER).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDC,
                fee: fee,
                recipient: trader,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
