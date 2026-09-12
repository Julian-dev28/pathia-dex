/**
 * The router's MCP tools, shared by two servers.
 *
 * `/api/mcp` (hosted) registers them with no account: it can quote and build
 * unsigned transactions, and nothing more, because a public endpoint must
 * never see a private key. `scripts/mcp.ts` (local, stdio) registers them with
 * an account loaded from the user's own machine, which adds `get_wallet` and
 * `swap` — the only tools that sign.
 *
 * Both paths keep the trade page's guard rails: exact approvals, an on-chain
 * output floor, and a refusal on high price impact unless the caller has
 * explicitly accepted it.
 */

import { z } from 'zod';
import { createWalletClient, fallback, getAddress, http, isAddress, type Address, type PrivateKeyAccount } from 'viem';
import { base } from 'viem/chains';
import type { McpServer } from '@modelcontextprotocol/server';
import { TOKENS, CHAIN_ID, EXPLORER, RPC_URLS, bySymbol, type Token } from './chain';
import { client } from './quote';
import { toBase, fromBase, jsonSafe } from './format';
import { buildSwap, approveTx, spenderFor, minOut, ERC20 } from './execute';
import { QUOTE_TTL_MS } from './serve';
import { solveQuote, type Solved } from './solve';

/** Same threshold the trade page asks a person to acknowledge. */
const HIGH_IMPACT_BPS = -300;
const SWAP_DEADLINE_SECONDS = 600;

const symbols = TOKENS.map((t) => t.symbol) as [string, ...string[]];
const pair = {
  tokenIn: z.enum(symbols).describe('Symbol of the token to sell'),
  tokenOut: z.enum(symbols).describe('Symbol of the token to buy'),
  amount: z
    .string()
    .regex(/^\d*\.?\d+$/)
    .max(30)
    .describe('Amount of tokenIn to sell, in whole units (e.g. "1.5"), not base units'),
};
const guards = {
  slippageBps: z.number().int().min(1).max(500).default(50).describe('Maximum slippage in basis points (50 = 0.5%)'),
  acceptHighImpact: z
    .boolean()
    .default(false)
    .describe('Set true only after the user has agreed to a price impact worse than 3%'),
};

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(jsonSafe(v), null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });
const human = (v: bigint, t: Token) => `${fromBase(v, t)} ${t.symbol}`;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/** Parse and quote, or say why not. */
async function quote(inSym: string, outSym: string, amount: string) {
  const tokenIn = bySymbol(inSym);
  const tokenOut = bySymbol(outSym);
  if (tokenIn.address === tokenOut.address) return { error: 'tokenIn and tokenOut are the same' };
  const amountIn = toBase(amount, tokenIn);
  if (amountIn <= 0n) return { error: 'amount must be greater than zero' };
  const { value } = await solveQuote(tokenIn, tokenOut, amountIn);
  if (!value) return { error: `no liquidity found for ${inSym}/${outSym} on Base` };
  return { tokenIn, tokenOut, amountIn, q: value };
}

/**
 * Price impact of the chosen venue: the fill rate at full size against the
 * rate at the smallest rung of the ladder. Negative means the size moves the
 * price against the trader.
 */
function impactBps(q: Solved, venueId: string): number | null {
  const rungs = q.venues.find((v) => v.venue.id === venueId)?.rungs;
  if (!rungs || rungs.length < 2) return null;
  const [first, last] = [rungs[0], rungs[rungs.length - 1]];
  if (first.amountIn === 0n || last.amountIn === 0n) return null;
  const small = Number(first.amountOut) / Number(first.amountIn);
  const full = Number(last.amountOut) / Number(last.amountIn);
  return small > 0 ? Math.round(((full - small) / small) * 10_000) : null;
}

/** Quote, apply the guards, check funds, and build the transactions in order. */
async function prepareSwap(args: {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  wallet: Address;
  slippageBps: number;
  acceptHighImpact: boolean;
}) {
  const r = await quote(args.tokenIn, args.tokenOut, args.amount);
  if ('error' in r) return { error: r.error! };
  const { tokenIn, tokenOut, amountIn, q } = r;
  const from = args.wallet;

  const venue = q.route.single.allocations[0].venue;
  const expected = q.route.single.amountOut;
  const floor = minOut(expected, args.slippageBps);
  const impact = impactBps(q, venue.id);
  if (impact !== null && impact < HIGH_IMPACT_BPS && !args.acceptHighImpact) {
    return {
      error: `Price impact is ${(impact / 100).toFixed(2)}%: selling ${human(amountIn, tokenIn)} on ${venue.label} returns ${human(expected, tokenOut)}. Confirm with the user, then call again with acceptHighImpact: true, or try a smaller amount.`,
    };
  }

  const spender = spenderFor(venue);
  const [balance, allowance] = await Promise.all([
    client().readContract({ address: tokenIn.address, abi: ERC20, functionName: 'balanceOf', args: [from] }),
    client().readContract({ address: tokenIn.address, abi: ERC20, functionName: 'allowance', args: [from, spender] }),
  ]);
  if (balance < amountIn) {
    return { error: `${from} holds ${human(balance, tokenIn)}; the swap needs ${human(amountIn, tokenIn)}.` };
  }

  const txs = [];
  if (allowance < amountIn) {
    txs.push({
      step: 'approve' as const,
      description: `Approve ${venue.label} router to spend exactly ${human(amountIn, tokenIn)}`,
      ...approveTx(tokenIn, spender, amountIn),
    });
  }
  txs.push({
    step: 'swap' as const,
    description: `Swap ${human(amountIn, tokenIn)} for at least ${human(floor, tokenOut)}`,
    ...buildSwap(venue, amountIn, floor, from, SWAP_DEADLINE_SECONDS),
  });

  return {
    tokenOut,
    txs,
    summary: {
      chainId: CHAIN_ID,
      from,
      venue: venue.label,
      path: venue.path.map((t) => t.symbol).join(' → '),
      sell: human(amountIn, tokenIn),
      expectedReceive: human(expected, tokenOut),
      minimumReceive: human(floor, tokenOut),
      slippageBps: args.slippageBps,
      priceImpactBps: impact,
      block: q.blockNumber,
    },
  };
}

export function registerTools(server: McpServer, account?: PrivateKeyAccount) {
  server.registerTool(
    'list_tokens',
    {
      title: 'List tokens',
      description:
        'Every token this router can quote and swap on Base mainnet (chain 8453): symbol, name, address, decimals. Tokens are passed to the other tools by symbol.',
      inputSchema: z.object({}),
    },
    async () => text(TOKENS),
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Get quote',
      description:
        'Quote selling `amount` of tokenIn for tokenOut across every DEX venue on Base (Uniswap V2/V3, PancakeSwap V3, SushiSwap, BaseSwap, Aerodrome), including two-hop routes through WETH or USDC. Returns the best single venue, whether splitting across venues would do better net of gas, price impact, and the block the prices were read at.',
      inputSchema: z.object(pair),
    },
    async ({ tokenIn: inSym, tokenOut: outSym, amount }) => {
      const r = await quote(inSym, outSym, amount);
      if ('error' in r) return fail(r.error!);
      const { tokenIn, tokenOut, amountIn, q } = r;
      const best = q.route.single.allocations[0];
      return text({
        sell: human(amountIn, tokenIn),
        block: q.blockNumber,
        bestVenue: {
          venue: best.venue.label,
          path: best.venue.path.map((t) => t.symbol).join(' → '),
          receive: human(q.route.single.amountOut, tokenOut),
          priceImpactBps: impactBps(q, best.venue.id),
        },
        split: {
          receive: human(q.route.split.amountOut, tokenOut),
          allocations: q.route.split.allocations.map((a) => `${a.share}% ${a.venue.label}`),
          edgeOverBestVenueBps: q.route.edgeBps,
          netOfGasBps: q.gas.gasAdjusted ? q.route.netEdgeBps : null,
        },
        recommended: q.route.chosen,
        venuesQuoted: q.venues.length,
        note: 'Swaps execute on the best single venue.',
      });
    },
  );

  server.registerTool(
    'build_swap',
    {
      title: 'Build swap',
      description:
        'Build the unsigned transactions to swap `amount` of tokenIn for tokenOut from `wallet` on Base (chain 8453), routed through the best single venue. Returns an exact-amount ERC-20 approval first if the wallet has not approved enough, then the swap. Send them in order from `wallet`, waiting for the approval to confirm; the swap must be mined within 10 minutes or it reverts. Nothing is signed or sent by this tool. The minimum output (slippage floor) is enforced on-chain. Refuses routes with more than 3% price impact unless acceptHighImpact is true.',
      inputSchema: z.object({
        ...pair,
        wallet: z
          .string()
          .refine((a) => isAddress(a), 'not an address')
          .describe('Address that holds tokenIn, signs both transactions, and receives tokenOut'),
        ...guards,
      }),
    },
    async (args) => {
      const plan = await prepareSwap({ ...args, wallet: getAddress(args.wallet) });
      if ('error' in plan) return fail(plan.error!);
      return text({
        ...plan.summary,
        quoteValidForSeconds: QUOTE_TTL_MS / 1000,
        transactions: plan.txs.map((t) => ({
          ...t,
          chainId: CHAIN_ID,
          from: plan.summary.from,
          value: `0x${t.value.toString(16)}`,
        })),
      });
    },
  );

  if (!account) return;

  // ── signing tools: local server only ──────────────────────────────────

  const urls = process.env.RPC_URL ? [process.env.RPC_URL, ...RPC_URLS] : [...RPC_URLS];
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: fallback(urls.map((url) => http(url, { timeout: 12_000 }))),
  });

  server.registerTool(
    'get_wallet',
    {
      title: 'Get wallet',
      description:
        'The address of the wallet this server trades from, its ETH balance (needed for gas on Base), and every non-zero balance among the tokens it can route.',
      inputSchema: z.object({}),
    },
    async () => {
      const c = client();
      const [eth, balances] = await Promise.all([
        c.getBalance({ address: account.address }),
        c.multicall({
          contracts: TOKENS.map((t) => ({
            address: t.address,
            abi: ERC20,
            functionName: 'balanceOf' as const,
            args: [account.address] as const,
          })),
          allowFailure: true,
        }),
      ]);
      return text({
        address: account.address,
        chainId: CHAIN_ID,
        eth: `${fromBase(eth, { symbol: 'ETH', name: 'Ether', address: '0x0000000000000000000000000000000000000000', decimals: 18 })} ETH`,
        tokens: TOKENS.flatMap((t, i) => {
          const b = balances[i];
          return b.status === 'success' && (b.result as bigint) > 0n ? [human(b.result as bigint, t)] : [];
        }),
      });
    },
  );

  server.registerTool(
    'swap',
    {
      title: 'Swap',
      description:
        'EXECUTES A REAL TRADE with the local wallet on Base mainnet, spending real funds. Sells `amount` of tokenIn for tokenOut through the best single venue: sends an exact-amount approval if needed, waits for it, then sends the swap and waits for confirmation. The minimum output is enforced on-chain. Refuses routes with more than 3% price impact unless acceptHighImpact is true. Confirm the trade with the user (get_quote first) before calling.',
      inputSchema: z.object({ ...pair, ...guards }),
    },
    async (args) => {
      const c = client();
      const plan = await prepareSwap({ ...args, wallet: account.address });
      if ('error' in plan) return fail(plan.error!);

      const sent: { step: string; hash: string; explorer: string }[] = [];
      try {
        const before = await c.readContract({
          address: plan.tokenOut.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account.address],
        });

        let lastBlock: bigint | undefined;
        for (const tx of plan.txs) {
          if (tx.step === 'swap') {
            // Dry-run against the state the approval produced, so a swap that
            // would revert costs nothing rather than its gas.
            try {
              await c.call({ account: account.address, to: tx.to, data: tx.data, blockNumber: lastBlock });
            } catch (e) {
              return fail(`Swap would revert, not sent: ${firstLine(e)}. Sent so far: ${JSON.stringify(sent)}`);
            }
          }
          const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
          sent.push({ step: tx.step, hash, explorer: `${EXPLORER}/tx/${hash}` });
          const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
          if (receipt.status !== 'success') {
            return fail(`${tx.step} transaction reverted: ${EXPLORER}/tx/${hash}`);
          }
          lastBlock = receipt.blockNumber;
        }

        const after = await c.readContract({
          address: plan.tokenOut.address,
          abi: ERC20,
          functionName: 'balanceOf',
          args: [account.address],
          blockNumber: lastBlock,
        });

        return text({
          ...plan.summary,
          received: human(after - before, plan.tokenOut),
          transactions: sent,
        });
      } catch (e) {
        return fail(`Swap failed: ${firstLine(e)}. Sent so far: ${JSON.stringify(sent)}`);
      }
    },
  );
}
