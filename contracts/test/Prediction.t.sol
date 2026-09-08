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

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

interface IV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory);
}

/**
 * The claim this project makes, put under test.
 *
 * `npm run predict` quotes a set of trades off-chain at a pinned block and
 * writes down what it thinks each one pays. This test forks that exact block
 * and performs the trades for real, against the deployed routers, with real
 * pool state — then compares. If the router's arithmetic is wrong, the
 * difference shows up here as basis points rather than as a user's bad fill.
 *
 * Pinning matters: a prediction made at head and replayed a minute later is
 * comparing two different markets, and the drift would be blamed on the maths.
 *
 * Public Base endpoints serve recent state but are not deep archives, so a
 * stale fixture is skipped with a message rather than failed. Regenerate with
 * `npm run predict` before running.
 */
contract PredictionTest is Test {
    address constant UNIV3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    /// Tolerance between the off-chain prediction and the realised fill.
    /// Uniswap's quoter simulates the swap exactly, and the constant-product
    /// maths here is exact integer arithmetic, so at a pinned block the only
    /// permitted difference is integer rounding. One basis point is already
    /// generous; it is not a fudge factor for a wrong formula.
    uint256 constant TOLERANCE_BPS = 1;

    string json;
    uint256 count;

    function setUp() public {
        string memory path = string.concat(vm.projectRoot(), "/test/fixtures/predictions.json");
        try vm.readFile(path) returns (string memory contents) {
            json = contents;
        } catch {
            json = "";
            return;
        }
        count = vm.parseJsonUint(json, ".count");

        uint256 pinned = vm.parseJsonUint(json, ".blockNumber");
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        try vm.createSelectFork(rpc, pinned) {
            // forked at the block the predictions were made at
        } catch {
            count = 0;
        }
    }

    function testPredictionsMatchRealisedFills() public {
        if (count == 0) {
            emit log("skipped: no fixture, or the pinned block is beyond the endpoint's history");
            emit log("run `npm run predict` to regenerate, then re-run forge test");
            return;
        }

        uint256 worstBps;
        string memory worstLabel;

        for (uint256 i = 0; i < count; i++) {
            // Each case runs against the pinned block's pristine state.
            //
            // Without this the cases contaminate each other: one case sells
            // 10 WETH into the same 0.05% pool a later case buys WETH from,
            // leaving that pool cheaper than it was when the prediction was
            // made. The later case duly came out 11bp better than predicted
            // and the suite blamed the arithmetic, which was exact. A fork is
            // shared mutable state, and a test that forgets that ends up
            // measuring its own side effects.
            uint256 snapshot = vm.snapshotState();

            (uint256 diffBps, string memory label) = _runCase(i);

            assertLe(diffBps, TOLERANCE_BPS, string.concat("prediction drifted: ", label));
            if (diffBps > worstBps) {
                worstBps = diffBps;
                worstLabel = label;
            }

            vm.revertToState(snapshot);
        }

        emit log_named_uint("cases checked", count);
        emit log_named_uint("worst drift bps", worstBps);
        emit log_named_string("worst case", worstLabel);
    }

    /// Split out from the loop purely to keep the stack under sixteen slots;
    /// inlined, this function makes the compiler give up.
    function _runCase(uint256 i) internal returns (uint256 diffBps, string memory label) {
        string memory base = string.concat(".cases[", vm.toString(i), "]");

        address tokenIn = vm.parseJsonAddress(json, string.concat(base, ".tokenIn"));
        address tokenOut = vm.parseJsonAddress(json, string.concat(base, ".tokenOut"));
        uint256 amountIn = vm.parseJsonUint(json, string.concat(base, ".amountIn"));
        uint256 predicted = vm.parseJsonUint(json, string.concat(base, ".predictedOut"));
        label = vm.parseJsonString(json, string.concat(base, ".label"));

        // A fresh actor per case, so one trade's leftovers cannot pay for the
        // next one's and hide a shortfall.
        address trader = address(uint160(uint256(keccak256(abi.encode("trader", i)))));
        deal(tokenIn, trader, amountIn);

        uint256 realised = _execute(
            trader, vm.parseJsonString(json, string.concat(base, ".venueKind")), base, tokenIn, tokenOut, amountIn
        );

        uint256 diff = realised > predicted ? realised - predicted : predicted - realised;
        diffBps = predicted == 0 ? type(uint256).max : (diff * 10_000) / predicted;

        emit log_named_string("case", label);
        emit log_named_uint("  predicted", predicted);
        emit log_named_uint("  realised ", realised);
        emit log_named_uint("  diff bps ", diffBps);
    }

    function _execute(
        address trader,
        string memory kind,
        string memory base,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 realised) {
        uint256 before = IERC20(tokenOut).balanceOf(trader);
        vm.startPrank(trader);

        if (_eq(kind, "v3")) {
            IERC20(tokenIn).approve(UNIV3_ROUTER, amountIn);
            ISwapRouter02(UNIV3_ROUTER).exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: uint24(vm.parseJsonUint(json, string.concat(base, ".fee"))),
                    recipient: trader,
                    amountIn: amountIn,
                    // Zero here on purpose: the point of the test is to observe
                    // what the venue actually pays, not to assert a floor. The
                    // floor is the app's job and is tested by its own path.
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (_eq(kind, "aero")) {
            IERC20(tokenIn).approve(AERO_ROUTER, amountIn);
            IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
            routes[0] = IAeroRouter.Route({
                from: tokenIn,
                to: tokenOut,
                stable: vm.parseJsonBool(json, string.concat(base, ".stable")),
                factory: AERO_FACTORY
            });
            IAeroRouter(AERO_ROUTER).swapExactTokensForTokens(
                amountIn, 0, routes, trader, block.timestamp + 600
            );
        } else {
            address router = vm.parseJsonAddress(json, string.concat(base, ".router"));
            IERC20(tokenIn).approve(router, amountIn);
            address[] memory path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
            IV2Router(router).swapExactTokensForTokens(
                amountIn, 0, path, trader, block.timestamp + 600
            );
        }

        vm.stopPrank();
        realised = IERC20(tokenOut).balanceOf(trader) - before;
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
