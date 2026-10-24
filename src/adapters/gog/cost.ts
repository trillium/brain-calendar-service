// What a sync costs when the transport is a CLI: every gog invocation is a
// process spawn plus at least one Google API request, so invocations are the
// unit, broken down by subcommand with the dominant one named.

export interface CallRecord {
  /** The gog calendar subcommand: events, raw, create, update, delete. */
  readonly command: string;
  readonly ms: number;
  readonly bytes: number;
}

interface Bucket {
  calls: number;
  bytes: number;
  ms: number;
}

interface CostProfile {
  calls: number;
  bytes: number;
  ms: number;
  byCommand: Record<string, Bucket>;
  /** The largest contributor by time, named; null when nothing was measured. */
  dominantByTime: { command: string; share: number } | null;
  callsPerSync: number;
}

export const profileCost = (log: readonly CallRecord[], rounds: number): CostProfile => {
  const byCommand: Record<string, Bucket> = {};
  let bytes = 0;
  let ms = 0;
  for (const r of log) {
    const bucket = byCommand[r.command] ?? { calls: 0, bytes: 0, ms: 0 };
    bucket.calls += 1;
    bucket.bytes += r.bytes;
    bucket.ms += r.ms;
    byCommand[r.command] = bucket;
    bytes += r.bytes;
    ms += r.ms;
  }
  let dominantByTime: CostProfile["dominantByTime"] = null;
  for (const [command, b] of Object.entries(byCommand)) {
    const share = ms ? b.ms / ms : 0;
    if (share > (dominantByTime?.share ?? 0)) dominantByTime = { command, share };
  }
  return {
    calls: log.length,
    bytes,
    ms,
    byCommand,
    dominantByTime,
    callsPerSync: rounds ? log.length / rounds : log.length,
  };
};
