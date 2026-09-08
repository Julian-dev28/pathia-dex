import type { Venue } from '@/lib/quote';

/**
 * The token path a route takes, e.g. WETH → USDC → DAI.
 *
 * Spelled out rather than folded into the venue name because which token a
 * trade passes through is a fact the user is entitled to before signing: a
 * two-hop route pays the fee twice and carries the intermediate pool's risk,
 * and "Uniswap V3 via USDC" does not say which USDC pool or in what order.
 */
export function RoutePath({ venue }: { venue: Venue }) {
  return (
    <span className="route-path">
      {venue.path.map((t, i) => (
        <span key={`${t.symbol}-${i}`}>
          {i > 0 && <span className="arr"> → </span>}
          <span className="hop">{t.symbol}</span>
        </span>
      ))}
    </span>
  );
}
