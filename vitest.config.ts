import { defineConfig } from "vitest/config";

// Node environment, not Canon's jsdom baseline (plan conflict C5).
// The risky logic in this service is temporal and server-side: recurrence, DST,
// and sync orchestration. jsdom would mask exactly the class of bug the whole
// architecture exists to prevent. Canon's jsdom config is added as a second
// Vitest project when a UI exists; it is deliberately NOT installed unused,
// which would trip Canon's own unused-deps rule.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    // S0 deliberately ships zero domain files, so an empty suite is the
    // correct state here rather than a failure. S1 removes this.
    passWithNoTests: true,
  },
});
