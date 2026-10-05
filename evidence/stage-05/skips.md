# S5 skip ledger (R13)

skip: The provider transport is still S6. What exists here is the loop mechanics that sit above it: policy, journal, retry policy, loop breaker, and the convergence harness driven by a recorded fixture rather than a live provider.
skip: The cursor lock is proven by a deterministic in-process interleaving test, not by a real Dolt lock across processes. A real cross-process lock belongs with the shared-server work, which is human-gated.
skip: No cross-calendar fan-out. One calendar is enough to prove or disprove convergence; fan-out adds breadth, not evidence.
skip: tsx was added as a devDependency so the CLI harnesses can import the TypeScript domain modules directly. It is a build tool, not a runtime dependency, and it is the smallest thing that makes `pnpm run sync:replay` and `pnpm run sync:converge` real commands instead of a test-only code path.
