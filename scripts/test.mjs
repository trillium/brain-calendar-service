// `pnpm run test -- <path> --run` forwards the literal `--` to vitest, which then
// treats everything after it as positional and runs the whole suite. Drop it so
// the documented stage exit commands narrow to the named file.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync("vitest", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
