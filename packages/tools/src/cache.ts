import type { ToolDoc } from "@satya/core";

/** Tool result cache (laptop: SQLite; cloud: ArchiveDO, 72 h). */
export interface ToolCache {
  get(key: string): Promise<ToolDoc[] | null>;
  put(key: string, docs: ToolDoc[], ttlS: number): Promise<void>;
}

export const DEFAULT_TOOL_CACHE_TTL_S = 72 * 3600;

/** Stable key: tool name + args with sorted keys. */
export function toolCacheKey(tool: string, args: object): string {
  const sorted = Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  return `tool:${tool}:${JSON.stringify(sorted)}`;
}

export class MemoryToolCache implements ToolCache {
  private readonly map = new Map<string, { docs: ToolDoc[]; expires: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): Promise<ToolDoc[] | null> {
    const hit = this.map.get(key);
    if (!hit) return Promise.resolve(null);
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(hit.docs);
  }

  put(key: string, docs: ToolDoc[], ttlS: number): Promise<void> {
    this.map.set(key, { docs, expires: this.now() + ttlS * 1000 });
    return Promise.resolve();
  }
}
