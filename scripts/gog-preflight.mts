#!/usr/bin/env tsx
// gog:preflight - is gog installed and signed in for GOG_ACCOUNT? Read only.
//
//   GOG_ACCOUNT=you@example.com pnpm run gog:preflight
//
// Exits 0 when ready, 3 when gog is missing or not signed in, 2 on a usage error.
// Source ~/.config/gog/env first when gog uses a file keyring (docs/soak.md).

import { gogPreflight } from "../src/adapters/gog/preflight.ts";
import { execRunner } from "../src/adapters/gog/runner.ts";

const account = process.env.GOG_ACCOUNT;
if (!account) {
  console.error("gog:preflight: set GOG_ACCOUNT to the address gog should act as");
  process.exit(2);
}

const result = await gogPreflight(execRunner(process.env.GOG_BIN ?? "gog"), account);
if (result.state === "ready") {
  console.log(`gog:preflight READY: ${result.version}, ${result.calendars} calendar(s) visible`);
} else {
  console.error(`gog:preflight ${result.state.toUpperCase()}: ${result.message}`);
  process.exit(3);
}
