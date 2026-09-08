/**
 * Shown on every page that can move money. Unaudited software that signs
 * mainnet transactions states that above the fold, in the same typeface as
 * everything else — a caution the reader can act on, not a modal to dismiss.
 */
export function Disclaimer() {
  return (
    <div className="disclaimer">
      <span>
        <strong>Unaudited, beta.</strong> Swaps execute through Uniswap&rsquo;s and
        Aerodrome&rsquo;s own deployed routers — this project never custodies funds and
        never holds an approval of its own. The minimum-output guard is enforced on-chain by
        those routers, not by this interface. Not affiliated with, or endorsed by, any venue
        named here.
      </span>
    </div>
  );
}
