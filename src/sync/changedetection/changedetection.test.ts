// S4's exit tests, against a real Dolt server.
//
// The plan names three cases explicitly, and they are the three ways change
// detection goes wrong in practice:
//   1. a row changed and changed back inside one sync window -> zero writes
//   2. a change to a non-temporal column -> zero calendar writes
//   3. a cursor pointing at a hash the database has never heard of -> a typed
//      full-resync state, NOT a silent empty diff that reads as "nothing
//      changed" and quietly stops syncing forever.

import type { Connection } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../adapters/dolt/config.mjs";
import { detectChanges, headCommit } from "./plan.js";
import { payloadHash, replay } from "./replay.js";

// THIS SUITE OWNS ITS OWN TABLE, CREATED AND DROPPED HERE.
//
// It used to share sync_probe_period with the schema suite, which made both of
// them order-dependent: a full run could lose rows another case had inserted,
// so the suite passed alone and failed in a full run. Shared mutable state
// between suites is the defect, not the run order, so each suite now owns its
// substrate outright.
const PROBE = "sync_probe_period";

/**
 * Stage and commit ONLY this suite's probe table.
 *
 * `DOLT_ADD('.')` followed by `DOLT_COMMIT('-Am', ...)` stages and commits every
 * modified table in the store, so a parallel suite's uncommitted rows were swept
 * into this suite's history the moment it committed. That is how a row inserted
 * by the schema suite ended up committed here, and then deleted - leaving the
 * store permanently dirty and failing every later run. Owning the substrate is
 * not enough; the commit has to be scoped to it too.
 */
const commitProbe = async (message: string) => {
  await conn.query("CALL DOLT_ADD('-A', ?)", [PROBE]);
  // --allow-empty: a change reverted inside the window nets to no diff, but the test
  // still needs the commit to exist to prove detection sees no change across it.
  await conn.query("CALL DOLT_COMMIT('--allow-empty', '-m', ?)", [message]);
};

let conn: Connection;

const createProbe = async () => {
  await conn.query(`CREATE TABLE IF NOT EXISTS ${PROBE} (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    grain VARCHAR(16) NOT NULL,
    period_start_utc DATETIME NOT NULL,
    period_end_utc DATETIME NOT NULL,
    linked_bead_id VARCHAR(64) NULL,
    attributes_json JSON NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY uq_probe_grain_start (grain, period_start_utc)
  ) ENGINE=InnoDB`);
  await commitProbe("s4 probe table");
};

beforeAll(async () => {
  conn = await createConnection(config);
  await conn.query(`DROP TABLE IF EXISTS ${PROBE}`);
  await createProbe();
});

afterAll(async () => {
  try {
    await conn.query(`DROP TABLE IF EXISTS ${PROBE}`);
    await commitProbe("s4 probe table dropped");
  } finally {
    await conn?.end();
  }
});

const insertPeriod = async (
  start: string,
  end: string,
  attributes: string,
  beadId: string | null,
) => {
  const ts = "2026-01-01 00:00:00";
  const [r] = await conn.query(
    `INSERT INTO sync_probe_period
       (grain, period_start_utc, period_end_utc, linked_bead_id, attributes_json,
        created_at, updated_at)
     VALUES ('day', ?, ?, ?, ?, ?, ?)`,
    [start, end, beadId, attributes, ts, ts],
  );
  return (r as { insertId: number }).insertId;
};

const commit = async (message: string) => {
  await commitProbe(message);
};

describe("change detection over dolt history and diff", () => {
  afterAll(async () => {});

  it("reports zero calendar writes when a row is changed and changed back in one window", async () => {
    const id = await insertPeriod(
      "2026-05-01 00:00:00",
      "2026-05-02 00:00:00",
      "{}",
      "brain-revert",
    );
    await commit("insert period");
    const cursor = await headCommit(conn);

    // Change it, then change it straight back inside the same sync window.
    await conn.query("UPDATE sync_probe_period SET period_start_utc = ? WHERE id = ?", [
      "2026-05-03 00:00:00",
      id,
    ]);
    await conn.query("UPDATE sync_probe_period SET period_start_utc = ? WHERE id = ?", [
      "2026-05-01 00:00:00",
      id,
    ]);
    await commit("change and revert");

    const result = await detectChanges(conn, PROBE, cursor);
    expect(result.state).toBe("ok");
    expect(result.state === "ok" && result.changedIds).toEqual([]);
  });

  it("reports zero calendar writes when only a non-temporal column changes", async () => {
    const id = await insertPeriod(
      "2026-06-01 00:00:00",
      "2026-06-02 00:00:00",
      "{}",
      "brain-nontemporal",
    );
    await commit("insert period 2");
    const cursor = await headCommit(conn);

    await conn.query("UPDATE sync_probe_period SET attributes_json = ? WHERE id = ?", [
      JSON.stringify({ label: "renamed" }),
      id,
    ]);
    await conn.query("UPDATE sync_probe_period SET linked_bead_id = ? WHERE id = ?", [
      "brain-other",
      id,
    ]);
    await commit("non-temporal change only");

    const result = await detectChanges(conn, PROBE, cursor);
    expect(result.state === "ok" && result.changedIds).toEqual([]);
  });

  it("reports the changed row when a temporal column really moves", async () => {
    const id = await insertPeriod(
      "2026-07-01 00:00:00",
      "2026-07-02 00:00:00",
      "{}",
      "brain-temporal",
    );
    await commit("insert period 3");
    const cursor = await headCommit(conn);
    await conn.query("UPDATE sync_probe_period SET period_start_utc = ? WHERE id = ?", [
      "2026-07-03 00:00:00",
      id,
    ]);
    await commit("temporal change");
    const result = await detectChanges(conn, PROBE, cursor);
    expect(result.state === "ok" && result.changedIds).toEqual([id]);
  });

  it("forces a full resync, loudly, when the cursor hash is absent", async () => {
    const result = await detectChanges(conn, PROBE, "0".repeat(40));
    expect(result.state).toBe("full_resync_required");
    expect(result.state === "full_resync_required" && result.reason).toMatch(
      /absent from dolt_log/,
    );
  });

  it("forces a full resync when there is no cursor at all", async () => {
    const result = await detectChanges(conn, PROBE, null);
    expect(result.state).toBe("full_resync_required");
  });
});

describe("sync:replay", () => {
  const fixture = {
    name: "unit",
    initial: [
      {
        uid: "evt-1@example.com",
        privateBeadId: "brain-1",
        sequence: 0,
        dtstamp: "2026-01-01T00:00:00Z",
        summary: "One",
        startUtc: "2026-03-02T14:00:00.000Z",
        durationSeconds: 900,
      },
    ],
    steps: [
      { label: "move", localEdit: { beadId: "brain-1", startUtc: "2026-03-02T15:00:00.000Z" } },
      {
        label: "remote",
        remoteEdit: { uid: "evt-1@example.com", startUtc: "2026-03-02T16:00:00.000Z" },
      },
    ],
  };

  it("never creates the same event twice, by UID, bead id, or payload hash", () => {
    const result = replay(fixture, 6);
    expect(result.duplicates).toEqual([]);
    const uids = result.rounds.flatMap((r) => r.writes.map((w) => w.uid));
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("reaches a fixpoint round with zero writes", () => {
    const result = replay(fixture, 6);
    expect(result.fixpointRound).not.toBeNull();
  });

  it("is deterministic: the same fixture and rounds give the same log", () => {
    expect(JSON.stringify(replay(fixture, 6))).toBe(JSON.stringify(replay(fixture, 6)));
  });

  it("hashes a payload the same regardless of key order", () => {
    const a = { ...fixture.initial[0], summary: "One" };
    const b = {
      summary: "One",
      startUtc: a.startUtc,
      uid: a.uid,
      durationSeconds: a.durationSeconds,
    };
    expect(payloadHash(a)).toBe(payloadHash(b as typeof a));
  });
});
