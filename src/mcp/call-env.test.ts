import { describe, expect, it } from "vitest";
import { PASSTHROUGH_ENV, serverEnv } from "./call-env.js";

describe("serverEnv", () => {
  it("passes the database and gog names through", () => {
    const env = serverEnv({
      CALENDAR_DB_PORT: "3417",
      CALENDAR_DB_NAME: "scratch",
      GOG_ACCOUNT: "someone@example.com",
      GOG_BIN: "/opt/bin/gog",
    });
    expect(env).toEqual({
      CALENDAR_DB_PORT: "3417",
      CALENDAR_DB_NAME: "scratch",
      GOG_ACCOUNT: "someone@example.com",
      GOG_BIN: "/opt/bin/gog",
    });
  });

  it("leaves out secrets and every name it was not told about", () => {
    const env = serverEnv({
      GOG_KEYRING_PASSWORD: "hunter2",
      GOG_KEYRING_BACKEND: "file",
      GOG_ACCESS_TOKEN: "token",
      GITHUB_TOKEN: "ghp_x",
      PATH: "/usr/bin",
      CALENDAR_DB_NAME: "scratch",
    });
    expect(Object.keys(env)).toEqual(["CALENDAR_DB_NAME"]);
  });

  it("drops names that are unset or empty so the server defaults still apply", () => {
    const env = serverEnv({ CALENDAR_DB_HOST: "", GOG_BIN: undefined });
    expect(env).toEqual({});
  });

  it("never lists a keyring or token variable", () => {
    for (const name of PASSTHROUGH_ENV) expect(name).not.toMatch(/KEYRING|TOKEN|SECRET/);
  });
});
