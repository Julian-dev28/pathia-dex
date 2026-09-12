/**
 * POST /api/mcp — the router as a hosted Model Context Protocol server.
 *
 * Read-only by construction: the tools are registered without an account, so
 * this endpoint can quote and build unsigned transactions but has no `swap`.
 * A public server must never be handed a private key; trading with one runs
 * locally through `npm run mcp` instead. See src/lib/mcp.ts.
 */

import { createMcpHandler } from 'mcp-handler';
import { registerTools } from '@/lib/mcp';
import { quoteLimit, clientKey } from '@/lib/serve';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = createMcpHandler((server) => registerTools(server), {
  serverInfo: { name: 'pathia-dex', version: '0.1.0' },
});

/** The quote endpoint's limit, so an agent cannot spend the RPC budget a person needs. */
async function limited(req: Request) {
  const limit = quoteLimit.check(clientKey(req));
  if (!limit.ok) {
    return Response.json(
      { error: 'rate limit exceeded — slow down' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((limit.resetAt - Date.now()) / 1000)) } },
    );
  }
  return handler(req);
}

export { limited as GET, limited as POST };
