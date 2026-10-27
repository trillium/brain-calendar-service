// The environment mcp:call hands to the server it spawns.
//
// The MCP SDK gives a child process only a small default environment, so a
// CALENDAR_DB_* override set on the mcp:call command line never reached the
// server and it quietly used the default database. The names below are passed
// through, and nothing else: the gog keyring variables stay out of the child, as
// do tokens and every other secret in the caller's environment.

export const PASSTHROUGH_ENV = [
  "CALENDAR_DB_HOST",
  "CALENDAR_DB_PORT",
  "CALENDAR_DB_NAME",
  "CALENDAR_DB_USER",
  "CALENDAR_DB_PASSWORD",
  "GOG_ACCOUNT",
  "GOG_BIN",
] as const;

export const serverEnv = (source: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = source[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
};
