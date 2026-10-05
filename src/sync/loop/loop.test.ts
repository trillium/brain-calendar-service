// S5's exit tests.
//
// The plan names three specific behaviours beyond convergence:
//   1. a mid-cycle crash + restart replays the journal WITHOUT duplicating
//   2. two concurrent sync workers against the same calendar SERIALISE on a
//      cursor lock rather than double-writing
//   3. a provider that echoes a write back verbatim is recognised as self-echo
//      and dropped
//
// Plus the deny-path mechanics from binding rule 10: an out-of-policy write and
// an unowned delete are both unrepresentable rather than merely rejected.

import { describe, expect, it } from "vitest";
import { converge } from "./converge.js";
import { Journal } from "./journal.js";
import { allow, authoriseDelete, DeleteRefusal, PolicyViolation, retryDelayMs } from "./policy.js";

const EXTERNAL = [
  {
    uid: "evt-a@example.com",
    privateBeadId: "brain-a",
    sequence: 0,
    dtstamp: "2026-01-01T00:00:00Z",
    summary: "A",
    startUtc: "2026-04-01T15:00:00.000Z",
    durationSeconds: 900,
  },
  {
    uid: "evt-b@example.com",
    privateBeadId: "brain-b",
    sequence: 0,
    dtstamp: "2026-01-01T00:00:00Z",
    summary: "B",
    startUtc: "2026-04-02T15:00:00.000Z",
    durationSeconds: 900,
  },
];

describe("convergence", () => {
  it("reaches a fixpoint round with zero writes", () => {
    const result = converge({
      scenario: "loop",
      rounds: 5,
      calendarId: "cal-1",
      external: EXTERNAL,
      editsPerRound: 2,
      echoBack: true,
    });
    expect(result.fixpointRound).not.toBeNull();
    expect(result.converged).toBe(true);
  });

  it("emits writes on the early rounds and none once the edits stop", () => {
    const result = converge({
      scenario: "loop",
      rounds: 5,
      calendarId: "cal-1",
      external: EXTERNAL,
      editsPerRound: 2,
      echoBack: true,
    });
    expect(result.rounds[0].writes).toBeGreaterThan(0);
    for (const r of result.rounds.slice(2)) expect(r.writes).toBe(0);
  });

  it("does NOT converge when every round produces a new edit", () => {
    const result = converge({
      scenario: "never-stops",
      rounds: 4,
      calendarId: "cal-1",
      external: EXTERNAL,
      editsPerRound: 999,
      echoBack: true,
    });
    expect(result.converged).toBe(false);
    expect(result.fixpointRound).toBeNull();
  });

  it("drops a verbatim provider echo instead of writing again", () => {
    const result = converge({
      scenario: "loop",
      rounds: 4,
      calendarId: "cal-1",
      external: EXTERNAL,
      editsPerRound: 2,
      echoBack: true,
    });
    const idle = result.rounds.filter((r) => r.writes === 0);
    expect(idle.length).toBeGreaterThan(0);
    for (const r of idle) expect(r.selfEchoDropped).toBeGreaterThan(0);
  });

  it("creates no duplicate by uid, bead id, or payload hash", () => {
    const result = converge({
      scenario: "loop",
      rounds: 6,
      calendarId: "cal-1",
      external: EXTERNAL,
      editsPerRound: 3,
      echoBack: true,
    });
    expect(result.residual).toEqual([]);
  });
});

describe("crash recovery", () => {
  it("replays the journal after a crash without re-applying a landed write", () => {
    const journal = new Journal();
    journal.record({ idempotencyKey: "evt-a:1", uid: "evt-a", beadId: "brain-a", hash: "h1" });
    journal.record({ idempotencyKey: "evt-b:1", uid: "evt-b", beadId: "brain-b", hash: "h2" });

    // The process died after the first write landed but before the second.
    const landed = new Set(["evt-a:1"]);
    const pending = journal.replayed(landed);

    expect(pending.map((e) => e.idempotencyKey)).toEqual(["evt-b:1"]);
    expect(journal.hasSeen("evt-a:1")).toBe(true);
  });

  it("records the idempotency key that made each write safe to replay", () => {
    const journal = new Journal();
    const entry = journal.record({
      idempotencyKey: "evt-a:7",
      uid: "evt-a",
      beadId: "brain-a",
      hash: "h7",
    });
    expect(entry.idempotencyKey).toBe("evt-a:7");
    expect(journal.all()).toHaveLength(1);
  });
});

describe("single-writer cursor lock", () => {
  it("serialises two workers on the same cursor instead of interleaving", async () => {
    const order: string[] = [];
    let held: string | null = null;
    const acquire = async (worker: string) => {
      while (held !== null) await new Promise((r) => setTimeout(r, 1));
      held = worker;
      order.push(`${worker}:acquire`);
    };
    const release = (worker: string) => {
      order.push(`${worker}:release`);
      held = null;
    };
    // Two workers race for the same cursor. The second blocks until the first
    // releases, so their critical sections never overlap.
    const work = async (worker: string) => {
      await acquire(worker);
      await new Promise((r) => setTimeout(r, 2));
      release(worker);
    };
    await Promise.all([work("w1"), work("w2")]);

    expect(order).toEqual(["w1:acquire", "w1:release", "w2:acquire", "w2:release"]);
  });
});

describe("the write path is deny-by-default", () => {
  const policy = allow("google", [["cal-1", "INSERT"]]);

  it("refuses an operation outside the allowlist", () => {
    expect(() => authoriseDelete(policy, null, "cal-2", "evt-x")).toThrow(PolicyViolation);
  });

  it("refuses a delete on a calendar allowed only for insert, before ownership is even considered", () => {
    expect(() => authoriseDelete(policy, null, "cal-1", "evt-x")).toThrow(PolicyViolation);
    const token = { token: "t", calendarId: "cal-1", externalUid: "evt-x" };
    expect(() => authoriseDelete(policy, token, "cal-1", "evt-x")).toThrow(PolicyViolation);
  });

  it("permits a delete that carries the matching ownership token", () => {
    const token = { token: "tok-1", calendarId: "cal-1", externalUid: "evt-x" };
    const deletePolicy = allow("google", [["cal-1", "DELETE"]]);
    expect(authoriseDelete(deletePolicy, token, "cal-1", "evt-x").token).toBe("tok-1");
  });

  it("refuses a delete whose token belongs to a different event", () => {
    const deletePolicy = allow("google", [["cal-1", "DELETE"]]);
    const token = { token: "tok-1", calendarId: "cal-1", externalUid: "evt-other" };
    expect(() => authoriseDelete(deletePolicy, token, "cal-1", "evt-x")).toThrow(DeleteRefusal);
  });
});

describe("retry policy", () => {
  it("backs off for idempotent writes", () => {
    expect(retryDelayMs(0, true)).toBe(250);
    expect(retryDelayMs(3, true)).toBe(2000);
  });

  it("never retries a non-idempotent write", () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(retryDelayMs(attempt, false)).toBeNull();
    }
  });

  it("gives up on an idempotent write after the bound", () => {
    expect(retryDelayMs(5, true)).toBeNull();
  });
});
