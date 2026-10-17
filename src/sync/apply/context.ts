// What every apply step shares. Everything non-deterministic is injected.

import type { Connection } from "mysql2/promise";
import type { SyncPolicy } from "../loop/policy.js";
import type { CalendarProvider } from "./provider.js";

export interface ApplyContext {
  readonly conn: Connection;
  readonly provider: CalendarProvider;
  readonly policy: SyncPolicy;
  /** The numeric calendar id as a string; it is the policy key and the BIGINT in Dolt. */
  readonly calendarId: string;
  /** Wall clock as a Dolt DATETIME string. */
  readonly now: () => string;
  readonly mintToken: () => string;
}

/** ISO-8601 UTC to a Dolt DATETIME literal. */
export const toDatetime = (iso: string): string => iso.slice(0, 19).replace("T", " ");
