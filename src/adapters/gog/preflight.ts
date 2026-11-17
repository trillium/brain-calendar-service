// Is gog ready to be the calendar transport on this host?
//
// A READ-ONLY probe: `gog --version`, then `gog -a <account> calendar calendars`
// with --readonly, which asks gog itself to block any mutating request. It exists so
// the first failure on a fresh always-on Mac is a sentence that names the fix,
// not a stack trace from the middle of a sync round.

import { GogError, type GogRunner } from "./runner.js";

type PreflightResult =
  | { readonly state: "ready"; readonly version: string; readonly calendars: number }
  | {
      readonly state:
        | "missing-binary"
        | "missing-client"
        | "not-authenticated"
        | "unreadable"
        | "failed";
      readonly message: string;
    };

const NO_CLIENT = /OAuth client credentials missing|auth credentials/i;
const NO_BINARY = /ENOENT/;
const NO_TOKEN = /no (stored )?tokens?|not (logged|signed) in|auth add|no stored token/i;

const countCalendars = (stdout: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { calendars?: unknown } | null)?.calendars;
  return Array.isArray(list) ? list.length : null;
};

const classify = (error: unknown): PreflightResult => {
  const text = error instanceof Error ? error.message : String(error);
  if (NO_BINARY.test(text)) {
    return { state: "missing-binary", message: "gog is not on PATH; install it or set GOG_BIN" };
  }
  if (error instanceof GogError) {
    if (NO_CLIENT.test(error.stderr)) {
      return {
        state: "missing-client",
        message:
          "gog has no OAuth client on this host; import the existing calendar application's " +
          "client with: gog auth credentials <credentials.json>",
      };
    }
    if (NO_TOKEN.test(error.stderr) || NO_TOKEN.test(error.message)) {
      return {
        state: "not-authenticated",
        message: `gog has no token for this account (${error.stderr.trim()}); run: gog auth add <address>`,
      };
    }
    return { state: "failed", message: error.message };
  }
  return { state: "failed", message: text };
};

export const gogPreflight = async (
  runner: GogRunner,
  account: string,
): Promise<PreflightResult> => {
  try {
    const version = (await runner(["--version"])).stdout.trim();
    const listed = await runner(["-a", account, "--json", "--readonly", "calendar", "calendars"]);
    const calendars = countCalendars(listed.stdout);
    if (calendars === null) {
      return { state: "unreadable", message: "gog calendar calendars did not return a list" };
    }
    return { state: "ready", version, calendars };
  } catch (error) {
    return classify(error);
  }
};
