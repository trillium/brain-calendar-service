// The operation journal.
//
// Every journal entry carries the idempotency key that produced it, which is
// what makes crash recovery replay-safe: on restart the journal is replayed, and
// an entry whose key has already been applied is skipped rather than re-applied.
// A journal that recorded "what we did" without "which key made it safe to do
// it" would be a list of side effects with no idempotence, which is worse than
// no journal at all.

export interface JournalEntry {
  readonly idempotencyKey: string;
  readonly uid: string;
  readonly beadId: string | null;
  readonly hash: string;
}

export class Journal {
  private readonly entries: JournalEntry[] = [];
  private readonly applied = new Set<string>();

  record(entry: JournalEntry): JournalEntry {
    this.entries.push(entry);
    this.applied.add(entry.idempotencyKey);
    return entry;
  }

  hasSeen(key: string): boolean {
    return this.applied.has(key);
  }

  all(): readonly JournalEntry[] {
    return this.entries;
  }

  /** Replay after a crash: returns the entries that were NOT already applied. */
  replayed(seen: ReadonlySet<string>): JournalEntry[] {
    return this.entries.filter((e) => !seen.has(e.idempotencyKey));
  }
}
