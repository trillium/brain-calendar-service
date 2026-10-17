// The provider interface the apply step writes through.
//
// Deliberately small, and deliberately WITHOUT a delete. The plan's binding rule
// 10 makes an unowned delete unrepresentable; the stronger form is that the apply
// path has no delete to call at all. Destructive cleanup of an external event is
// a human-gated action, so it is not part of this surface. If it ever needs to
// exist it arrives as a separate, explicitly named interface that the apply step
// does not receive.
//
// Every write is idempotent by construction: INSERT is keyed on a uid the caller
// chooses, so a retried INSERT that actually landed returns the existing event
// instead of creating a second one.

import { fileURLToPath } from "node:url";
import { createTokenSource, loadCredentials } from "../../adapters/caldav/auth.js";
import { createGoogleReader } from "../../adapters/gcal/reader.js";
import type { Occurrence } from "../../domain/rfc5546/types.js";

export interface EventPayload {
  readonly summary: string;
  readonly startUtc: string;
  readonly endUtc: string;
}

interface ProviderEvent {
  readonly externalUid: string;
  readonly etag: string;
}

interface WriteContext {
  /** Same key on a retry. A provider uses it to recognise its own earlier write. */
  readonly idempotencyKey: string;
}

export interface CalendarProvider {
  /** Create `uid`, or return it unchanged if it already exists. */
  insert(
    calendarId: string,
    uid: string,
    payload: EventPayload,
    ctx: WriteContext,
  ): Promise<ProviderEvent & { readonly created: boolean }>;
  /** Replace `uid`. `ifMatch` is the etag we last saw; a mismatch must throw, not overwrite. */
  update(
    calendarId: string,
    uid: string,
    payload: EventPayload,
    ifMatch: string | null,
    ctx: WriteContext,
  ): Promise<ProviderEvent>;
}

/** One provider request as observed. Method and status only: a URL names the calendar. */
interface ObservedCall {
  readonly method: string;
  readonly status?: number;
}

export interface RemoteRead {
  readonly occurrences: readonly Occurrence[];
  /** What the transport actually sent. The plan records these, it does not assume them. */
  readonly calls: readonly ObservedCall[];
}

/** The read half. It has no write method to call, so reading cannot mutate a calendar. */
interface RemoteReader {
  readWindow(
    calendarId: string,
    window: { readonly from: string; readonly to: string },
  ): Promise<RemoteRead>;
}

interface ConfiguredProvider {
  readonly reader: RemoteReader;
  /**
   * Null until the write path is built and approved. A sync:once that has
   * changes to apply and no writer refuses before writing anything.
   */
  readonly writer: CalendarProvider | null;
}

const CREDENTIAL_VARS = [
  "CALENDAR_OAUTH_CLIENT_ID",
  "CALENDAR_OAUTH_CLIENT_SECRET",
  "CALENDAR_OAUTH_REFRESH_TOKEN",
  "CALENDAR_OAUTH_FILE",
] as const;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface ProviderDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly repoRoot?: string;
}

/**
 * The provider sync:once talks to: Google Calendar API v3, read only for now.
 *
 * Returns null only when NO credential variable is set at all, which means "not
 * configured" and lets a dry-run say so. A partly configured environment is a
 * mistake worth failing on, so it throws CredentialsError naming the missing
 * variable (never a value) instead of quietly falling back to "no provider".
 * Credentials are read from variables by NAME and are never logged.
 */
export const configuredProvider = (deps: ProviderDeps = {}): ConfiguredProvider | null => {
  const env = deps.env ?? process.env;
  if (CREDENTIAL_VARS.every((name) => !env[name])) return null;
  const doFetch = deps.fetch ?? fetch;
  const loaded = loadCredentials({ env, repoRoot: deps.repoRoot ?? REPO_ROOT });
  const auth = createTokenSource(loaded, { fetch: doFetch, now: deps.now ?? Date.now });
  // Like CALENDAR_OAUTH_TOKEN_URL, a test seam; createGoogleReader still insists on https or loopback.
  const baseUrl = env.CALENDAR_GOOGLE_BASE_URL;
  return { reader: createGoogleReader({ auth, fetch: doFetch, baseUrl }), writer: null };
};
