// The only place this service starts a process. gog is the calendar transport:
// it owns OAuth, token storage, and the Google API, so none of that lives here.
//
// execFile with an argv array, never a shell: calendar ids and event text come
// from outside and must not be interpretable as shell syntax.

import { execFile } from "node:child_process";

interface GogRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type GogRunner = (args: readonly string[]) => Promise<GogRunResult>;

export class GogError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "GogError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export const execRunner =
  (bin: string, timeoutMs = DEFAULT_TIMEOUT_MS): GogRunner =>
  (args) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        [...args],
        { maxBuffer: MAX_BUFFER, timeout: timeoutMs, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ stdout, stderr });
            return;
          }
          const code = typeof err.code === "number" ? err.code : null;
          reject(
            new GogError(
              `gog ${args.slice(0, 3).join(" ")} failed (${err.code ?? err.message}): ${stderr.trim()}`,
              code,
              stderr,
            ),
          );
        },
      );
    });

/** The calendar subcommand in an argv built by the provider (events, raw, create, ...). */
export const subcommandOf = (args: readonly string[]): string => {
  const rest = args.slice(args.indexOf("calendar") + 1);
  return rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "-a") ?? "?";
};

/**
 * Wrap a runner so every call it is asked to make is recorded, by calendar
 * subcommand. The record is what a plan's provider-call observation is read from.
 */
export const recordingRunner = (inner: GogRunner) => {
  const calls: { method: string }[] = [];
  const runner: GogRunner = (args) => {
    calls.push({ method: subcommandOf(args) });
    return inner(args);
  };
  return { runner, calls };
};
