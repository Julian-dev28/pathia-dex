/**
 * Structured logging and in-process metrics.
 *
 * One line of JSON per event, because the only consumer that matters is
 * whatever is tailing the deployment's stdout, and a log line a machine cannot
 * parse is a log line nobody greps twice. Locally it prints a readable form
 * instead — JSON in a terminal is noise a developer has to decode by eye.
 *
 * The counters are in-process, which on serverless means per-instance. That is
 * stated plainly rather than dressed up: they answer "is this instance healthy
 * and what is it doing", not "how much traffic does the product get". A real
 * metrics backend is a service dependency this project deliberately does not
 * have.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const PRETTY = process.env.NODE_ENV !== 'production';

function emit(level: Level, event: string, fields?: Fields) {
  const entry = { ts: new Date().toISOString(), level, event, ...fields };
  const line = PRETTY
    ? `${level.toUpperCase().padEnd(5)} ${event}${fields ? ' ' + JSON.stringify(fields) : ''}`
    : JSON.stringify(entry);

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => PRETTY && emit('debug', event, fields),
  info: (event: string, fields?: Fields) => emit('info', event, fields),
  warn: (event: string, fields?: Fields) => emit('warn', event, fields),
  error: (event: string, fields?: Fields) => emit('error', event, fields),
};

/**
 * Counters and latency, kept as a fixed set of names.
 *
 * A free-form metric registry grows a long tail of names nobody reads. These
 * are the ones that would actually change a decision: how often quotes fail,
 * how often the cache saves an RPC round trip, and what the tail latency looks
 * like.
 */
class Metrics {
  private counters = new Map<string, number>();
  private latencies: number[] = [];
  private readonly startedAt = Date.now();

  inc(name: string, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /** Records a quote latency. Bounded: the last 500 samples, not all of them. */
  observeLatency(ms: number) {
    this.latencies.push(ms);
    if (this.latencies.length > 500) this.latencies.shift();
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (p: number) =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters),
      quoteLatencyMs: {
        samples: sorted.length,
        p50: at(50),
        p90: at(90),
        p99: at(99),
        max: sorted[sorted.length - 1] ?? 0,
      },
    };
  }
}

export const metrics = new Metrics();
