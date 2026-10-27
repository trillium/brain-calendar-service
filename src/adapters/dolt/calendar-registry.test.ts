import type { RowDataPacket } from "mysql2";
import type { Connection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, openDirect, type TestDatabase } from "../../mcp/test-db.js";
import {
  CalendarNotRegistered,
  isNumericReference,
  registerCalendar,
  resolveCalendar,
} from "./calendar-registry.js";

let db: TestDatabase;
let conn: Connection;

beforeAll(async () => {
  db = await createTestDatabase();
  conn = await openDirect(db.name);
  await conn.query("CALL DOLT_ADD('-A')");
  await conn.query("CALL DOLT_COMMIT('-m', 'schema')");
});

afterAll(async () => {
  await conn.end();
  await db.drop();
});

const logLength = async (): Promise<number> => {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM dolt_log");
  return Number(rows[0]?.n);
};

describe("calendar registry", () => {
  const remote = "abc123@group.calendar.google.com";

  it("maps a remote id to a numeric id, idempotently, as a Dolt commit", async () => {
    const before = await logLength();
    const first = await registerCalendar(conn, {
      provider: "google",
      remoteCalendarId: remote,
      displayName: "throwaway",
    });
    expect(first).toMatchObject({ provider: "google", remoteCalendarId: remote });
    expect(await logLength()).toBe(before + 1);

    const again = await registerCalendar(conn, {
      provider: "google",
      remoteCalendarId: remote,
      displayName: "renamed is ignored",
    });
    expect(again).toEqual(first);
    expect(await logLength()).toBe(before + 1);
  });

  it("resolves a remote id, a bare integer and cal-<n> to the same store id", async () => {
    const { id } = await resolveCalendar(conn, remote, "google");
    expect((await resolveCalendar(conn, String(id), "google")).id).toBe(id);
    const alias = await resolveCalendar(conn, `cal-${id}`, "google");
    expect(alias.id).toBe(id);
    expect(alias.registered?.remoteCalendarId).toBe(remote);
  });

  it("keeps an unregistered integer id working, with no remote calendar attached", async () => {
    expect(await resolveCalendar(conn, "cal-4242", "google")).toEqual({
      id: 4242,
      registered: null,
    });
  });

  it("refuses an unregistered remote id and a non-positive integer", async () => {
    await expect(resolveCalendar(conn, "nobody@example.com", "google")).rejects.toThrow(
      CalendarNotRegistered,
    );
    await expect(resolveCalendar(conn, "cal-0", "google")).rejects.toThrow(/positive integer/);
    await expect(
      registerCalendar(conn, { provider: "google", remoteCalendarId: " ", displayName: "x" }),
    ).rejects.toThrow(/needs a provider/);
  });

  it("tells numeric references from remote ids", () => {
    expect(["1", "cal-12"].every(isNumericReference)).toBe(true);
    expect(["primary", "a@b.c", "cal-x", ""].some(isNumericReference)).toBe(false);
  });
});
