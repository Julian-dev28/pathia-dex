// Human-readable fragments only — we never pull a full artifact JSON for four
// functions. viem parses these at build time.

export const multicall3Abi = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
] as const;

export const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

export const v2FactoryAbi = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
] as const;

export const v2PairAbi = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
] as const;

// Aerodrome is a Solidly fork: pools are stable or volatile, and the fee is set
// per-pool by the factory rather than being a constant. Replicating its curve
// off-chain is how you ship a wrong number, so we ask the pool itself.
export const univ3FactoryAbi = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
] as const;

export const aeroFactoryAbi = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
] as const;

export const aeroPoolAbi = [
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
] as const;

// QuoterV2 is declared nonpayable because it quotes by executing the swap and
// reverting. Inside eth_call that is harmless — state is discarded — so it
// batches through Multicall3 like any view function.
export const quoterV2Abi = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  // Multi-hop. The path is packed token,fee,token,fee,token — see encodeV3Path.
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
] as const;

export const univ3RouterAbi = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  // Multi-hop, atomic: one transaction, one minimum-output check on the end of
  // the path. SwapRouter02 carries no deadline field; it wraps calls in
  // multicall(deadline, ...) when one is wanted.
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
] as const;

// PancakeSwap V3 forked Uniswap's original SwapRouter, whose swap params carry
// a deadline. Uniswap's SwapRouter02 dropped it. Same function names, different
// structs, different selectors — encoding one against the other reverts.
export const v3RouterWithDeadlineAbi = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
] as const;

export const aeroRouterAbi = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  // Quoting Aerodrome through its own router rather than reimplementing the
  // Solidly invariant: it handles stable and volatile curves and chains hops.
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
] as const;

export const v2RouterAbi = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
] as const;
