// Base mainnet. Every address below was verified to have bytecode on-chain by
// scripts/verify-addresses.sh, which runs in CI. None of them are copied from a
// blog post. Re-run that script if you fork this for another chain.
export const CHAIN_ID = 8453;

export const RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
] as const;

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

// Execution goes through these. They are audited, deployed, and not ours: this
// project computes the route, it does not custody funds at any point.
export const UNIV3_SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481' as const;
export const UNIV3_QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as const;
export const UNIV3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as const;
export const AERO_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const;
export const AERO_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const;

export const UNIV3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Fee tiers considered for the *middle* of a multi-hop route.
 *
 * All four tiers squared is sixteen candidates per intermediate, and on Base
 * the 0.01% and 1% tiers are near-empty for anything but stable pairs — so
 * fourteen of those sixteen are dead pools that each cost a contract call to
 * discover. Two tiers covers the liquidity that exists.
 */
export const UNIV3_MULTIHOP_FEE_TIERS = [500, 3000] as const;

/**
 * Concentrated-liquidity deployments, as data.
 *
 * Uniswap V3 and its forks share a quoter ABI, so a fork is a table entry
 * rather than a code path. What they do *not* share is the router: PancakeSwap
 * forked Uniswap's original `SwapRouter`, which carries a `deadline` field in
 * its swap params, while Uniswap moved to `SwapRouter02`, which does not.
 * Encoding one against the other reverts every swap, so the difference is
 * recorded here and checked in `scripts/probe-venues.ts` by reading the
 * selectors out of the deployed bytecode.
 *
 * Fee tiers differ too: Pancake's third tier is 0.25% where Uniswap's is 0.30%.
 */
export type V3Deployment = {
  name: string;
  quoter: `0x${string}`;
  router: `0x${string}`;
  factory: `0x${string}`;
  feeTiers: readonly number[];
  multiHopTiers: readonly number[];
  /** True when the router's swap params include a deadline (SwapRouter v1). */
  routerHasDeadline: boolean;
};

export const V3_DEPLOYMENTS: V3Deployment[] = [
  {
    name: 'Uniswap V3',
    quoter: UNIV3_QUOTER,
    router: UNIV3_SWAP_ROUTER,
    factory: UNIV3_FACTORY,
    feeTiers: UNIV3_FEE_TIERS,
    multiHopTiers: UNIV3_MULTIHOP_FEE_TIERS,
    routerHasDeadline: false,
  },
  {
    name: 'PancakeSwap V3',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    feeTiers: [100, 500, 2500, 10000],
    multiHopTiers: [500, 2500],
    routerHasDeadline: true,
  },
];

export type Token = {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
};

export const TOKENS: Token[] = [
  { symbol: 'WETH', name: 'Wrapped Ether', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', name: 'USD Coin', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
  { symbol: 'USDT', name: 'Tether USD', address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
  // Minted by the Base–Solana bridge; 9 decimals, same as native SOL.
  { symbol: 'SOL', name: 'Solana', address: '0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82', decimals: 9 },
  { symbol: 'cbXRP', name: 'Coinbase Wrapped XRP', address: '0xcb585250f852C6c6bf90434AB21A00f02833a4af', decimals: 6 },
  { symbol: 'DAI', name: 'Dai Stablecoin', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  { symbol: 'cbETH', name: 'Coinbase Wrapped Staked ETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped liquid staked Ether', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  { symbol: 'rETH', name: 'Rocket Pool ETH', address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', decimals: 18 },
  { symbol: 'USDbC', name: 'USD Base Coin', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
  { symbol: 'AERO', name: 'Aerodrome', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  { symbol: 'DEGEN', name: 'Degen', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
  { symbol: 'BRETT', name: 'Brett', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', decimals: 18 },
  { symbol: 'VIRTUAL', name: 'Virtual Protocol', address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', decimals: 18 },
  // Coinbase tokenized stocks (B20 precompiles, listed at base.org/stocks). Only
  // those with a Uniswap or PancakeSwap V3 pool: MSTRc, SNDKc and TSLAc had none
  // this router can reach.
  { symbol: 'NVDAc', name: 'NVIDIA Corporation', address: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8 },
  { symbol: 'AAPLc', name: 'Apple Inc.', address: '0xb200000000000000000000C2e324d24d7eEcd1fb', decimals: 8 },
  { symbol: 'GOOGLc', name: 'Alphabet Inc.', address: '0xb2000000000000000000002D0BA3164cc74f58B7', decimals: 8 },
  { symbol: 'SPCXc', name: 'Space Exploration Technologies Corp.', address: '0xb2000000000000000000007b9fcbd005511aCBd5', decimals: 8 },
  { symbol: 'AMZNc', name: 'Amazon.com Inc.', address: '0xb200000000000000000000d9192b6B456483C2E8', decimals: 8 },
  { symbol: 'MSFTc', name: 'Microsoft Corporation', address: '0xB200000000000000000000Ab99cFa739E253872B', decimals: 8 },
  { symbol: 'METAc', name: 'Meta Platforms Inc.', address: '0xb2000000000000000000008bC8786B856E61707C', decimals: 8 },
];

export const WETH: Token = TOKENS[0];
export const USDC: Token = TOKENS[1];

/**
 * Tokens a two-hop route may pass through.
 *
 * On Base essentially all liquidity is paired against WETH or USDC, so a route
 * that cannot reach one of them has no depth worth finding. Adding more
 * intermediates multiplies the candidate set without adding routes that exist.
 */
export const INTERMEDIATES: Token[] = [WETH, USDC];

export const bySymbol = (s: string): Token => {
  const t = TOKENS.find((x) => x.symbol.toLowerCase() === s.toLowerCase());
  if (!t) throw new Error(`unknown token: ${s}`);
  return t;
};

export const byAddress = (a: string): Token | undefined =>
  TOKENS.find((t) => t.address.toLowerCase() === a.toLowerCase());

// V2 forks differ only in their factory, their router, and their fee numerator,
// so they are data rather than code. Fees are in basis points of 10_000 —
// BaseSwap takes 25bp where the others take 30, and one shared constant would
// misprice every BaseSwap trade.
export type V2Venue = {
  name: string;
  factory: `0x${string}`;
  router: `0x${string}`;
  feeBps: number;
};

export const V2_VENUES: V2Venue[] = [
  {
    name: 'Uniswap V2',
    factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
    feeBps: 30,
  },
  {
    name: 'SushiSwap',
    factory: '0x71524B4f93c58fcbF659783284E38825f0622859',
    router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
    feeBps: 30,
  },
  {
    name: 'BaseSwap',
    factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
    router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
    feeBps: 25,
  },
];

export const EXPLORER = 'https://basescan.org';
