// Per-host politeness: at most one request per interval per host (§7 M2: ≤ 1 req/s).

/** arXiv's API terms ask for one request every 3 s, which is stricter than the default. */
export const HOST_INTERVAL_OVERRIDES_MS: Readonly<Record<string, number>> = { "export.arxiv.org": 3000 };

export class HostRateLimiter {
  private readonly nextFree = new Map<string, number>();

  constructor(
    private readonly intervalMs = 1000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly overrides: Readonly<Record<string, number>> = HOST_INTERVAL_OVERRIDES_MS,
  ) {}

  /** Resolves when a request to `host` may be sent; reservations are FIFO per host. */
  async wait(host: string): Promise<void> {
    const interval = this.overrides[host] ?? this.intervalMs;
    const now = this.now();
    const slot = Math.max(now, this.nextFree.get(host) ?? 0);
    this.nextFree.set(host, slot + interval);
    if (slot > now) await this.sleep(slot - now);
  }
}
