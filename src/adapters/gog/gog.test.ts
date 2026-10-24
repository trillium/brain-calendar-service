// Provider tests against a fake gog executable: a real child process, real argv,
// real exit codes, no network and no account. Live behaviour needs `gog auth`.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allow, DeleteRefusal, PolicyViolation } from "../../sync/loop/policy.js";
import { type CallRecord, profileCost } from "./cost.js";
import { createGogProvider, gogProviderFromEnv } from "./provider.js";
import { GogError, type GogRunner } from "./runner.js";

const FAKE = resolve(import.meta.dirname, "../../../fixtures/gog/fake-gog.mjs");
const ACCOUNT = "test-account@example.invalid";
const TEST_CAL = "test-calendar-id";

let dir: string;
let log: string;

const calls = (): string[][] =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gog-"));
  log = join(dir, "calls.log");
  process.env.FAKE_GOG_LOG = log;
  process.env.FAKE_GOG_FAIL = "";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.FAKE_GOG_LOG = "";
  process.env.FAKE_GOG_FAIL = "";
});

const provider = () => createGogProvider({ account: ACCOUNT, bin: FAKE });
const policy = allow("gog", [
  [TEST_CAL, "INSERT"],
  [TEST_CAL, "UPDATE"],
  [TEST_CAL, "DELETE"],
]);

describe("reads", () => {
  it("lists events and maps private properties", async () => {
    const events = await provider().listEvents(TEST_CAL, { from: "2026-03-01", max: 5 });
    expect(events.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(events[0]?.privateProperties).toEqual({ "X-Beads-Id": "bead-e1" });
    const [argv] = calls();
    expect(argv).toEqual(
      expect.arrayContaining(["calendar", "-a", ACCOUNT, "--json", "--no-input", "events"]),
    );
    expect(argv).toEqual(expect.arrayContaining(["--from=2026-03-01", "--max=5", TEST_CAL]));
  });

  it("gets one event through gog's lossless raw dump", async () => {
    const event = await provider().getEvent(TEST_CAL, "abc");
    expect(event.id).toBe("abc");
    expect(calls()[0]).toContain("raw");
  });
});

describe("writes", () => {
  it("creates with private-prop markers and no guest notifications", async () => {
    const created = await provider().createEvent(policy, TEST_CAL, {
      summary: "Planned",
      from: "2026-03-04T10:00:00Z",
      to: "2026-03-04T11:00:00Z",
      privateProperties: { "X-Beads-Id": "bead-1" },
    });
    expect(created.id).toBe("created-1");
    expect(created.summary).toBe("Planned");
    const argv = calls()[0] ?? [];
    expect(argv).toEqual(
      expect.arrayContaining(["create", "--summary=Planned", "--private-prop=X-Beads-Id=bead-1"]),
    );
    expect(argv).toContain("--send-updates=none");
  });

  it("updates an event", async () => {
    const updated = await provider().updateEvent(policy, TEST_CAL, "e1", { summary: "Moved" });
    expect(updated.summary).toBe("Moved");
    expect(calls()[0]).toEqual(expect.arrayContaining(["update", TEST_CAL, "e1"]));
  });

  it("deletes only with an ownership token", async () => {
    const token = { token: "t", calendarId: TEST_CAL, externalUid: "e1" };
    await provider().deleteEvent(policy, token, TEST_CAL, "e1");
    expect(calls()[0]).toEqual(expect.arrayContaining(["delete", "--force", TEST_CAL, "e1"]));
  });
});

describe("deny-by-default", () => {
  it("refuses a write to a calendar outside the policy, without invoking gog", async () => {
    await expect(provider().createEvent(policy, "other-calendar", {})).rejects.toBeInstanceOf(
      PolicyViolation,
    );
    expect(() => readFileSync(log)).toThrow();
  });

  it("refuses an unowned delete, without invoking gog", async () => {
    await expect(provider().deleteEvent(policy, null, TEST_CAL, "e1")).rejects.toBeInstanceOf(
      DeleteRefusal,
    );
    expect(() => readFileSync(log)).toThrow();
  });

  it("refuses an id that gog would parse as a flag", async () => {
    await expect(provider().getEvent(TEST_CAL, "--force")).rejects.toThrow(/unsafe/);
  });
});

describe("failure is a typed state", () => {
  it("surfaces a gog failure as GogError with the exit code", async () => {
    process.env.FAKE_GOG_FAIL = "1";
    const err = await provider()
      .listEvents(TEST_CAL)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GogError);
    expect((err as GogError).exitCode).toBe(1);
    expect((err as GogError).stderr).toContain("no stored token");
  });

  it("rejects an event payload that does not validate", async () => {
    const runner: GogRunner = async () => ({
      stdout: '{"events":[{"summary":"no id"}]}',
      stderr: "",
    });
    await expect(
      createGogProvider({ account: ACCOUNT, runner }).listEvents(TEST_CAL),
    ).rejects.toThrow();
  });

  it("rejects non-JSON output", async () => {
    const runner: GogRunner = async () => ({ stdout: "not json", stderr: "" });
    await expect(
      createGogProvider({ account: ACCOUNT, runner }).getEvent(TEST_CAL, "e1"),
    ).rejects.toBeInstanceOf(GogError);
  });
});

describe("account configuration", () => {
  it("has no default account", () => {
    expect(() => gogProviderFromEnv({}, { bin: FAKE })).toThrow(/account/);
  });

  it("takes the account from GOG_ACCOUNT", async () => {
    await gogProviderFromEnv({ GOG_ACCOUNT: "env@example.invalid" }, { bin: FAKE }).listEvents(
      TEST_CAL,
    );
    expect(calls()[0]).toContain("env@example.invalid");
  });

  it("passes --readonly through when asked", async () => {
    await createGogProvider({ account: ACCOUNT, bin: FAKE, readonly: true }).listEvents(TEST_CAL);
    expect(calls()[0]).toContain("--readonly");
  });
});

describe("google limits are enforced before gog is invoked", () => {
  it("refuses an over-long private-property key on create", async () => {
    await expect(
      provider().createEvent(policy, TEST_CAL, { privateProperties: { ["k".repeat(45)]: "v" } }),
    ).rejects.toThrow(/DROPS/);
    expect(() => readFileSync(log)).toThrow();
  });
});

describe("cost accounting", () => {
  const entries: CallRecord[] = [
    { command: "events", ms: 40, bytes: 900 },
    { command: "raw", ms: 30, bytes: 100 },
    { command: "raw", ms: 20, bytes: 100 },
  ];

  it("counts calls per sync and names what dominated", () => {
    const profile = profileCost(entries, 2);
    expect(profile.callsPerSync).toBe(1.5);
    expect(profile.dominantByTime?.command).toBe("raw");
    expect(profile.byCommand.raw?.calls).toBe(2);
    expect(profile.bytes).toBe(1100);
  });

  it("reports nothing dominant for an empty measurement", () => {
    expect(profileCost([], 3).dominantByTime).toBeNull();
  });
});

describe("flags gog actually accepts (the fake rejects unknown flags)", () => {
  it("updates with a time zone using the per-end flags", async () => {
    await provider().updateEvent(policy, TEST_CAL, "e1", { timeZone: "America/Los_Angeles" });
    const argv = calls()[0] ?? [];
    expect(argv).toContain("--start-timezone=America/Los_Angeles");
    expect(argv).toContain("--end-timezone=America/Los_Angeles");
    expect(argv).not.toContain("--timezone=America/Los_Angeles");
  });

  it("creates with --timezone", async () => {
    await provider().createEvent(policy, TEST_CAL, { timeZone: "America/Los_Angeles" });
    expect(calls()[0]).toContain("--timezone=America/Los_Angeles");
  });

  it("refuses a marker value gog would split on a comma", async () => {
    await expect(
      provider().createEvent(policy, TEST_CAL, { privateProperties: { "X-Beads-Id": "a,b" } }),
    ).rejects.toThrow(/comma/);
    expect(() => readFileSync(log)).toThrow();
  });
});
