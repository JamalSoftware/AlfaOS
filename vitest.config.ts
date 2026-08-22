import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    globalSetup: ["./src/tests/globalSetup.ts"],
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Test files share a single Postgres database (alfaos_test) and each
    // resets it in beforeEach; running files in parallel races on that
    // shared state and produces spurious FK/unique-constraint failures.
    fileParallelism: false,
  },
  // tsconfig keeps `jsx: "preserve"` for the Next.js compiler, which would make
  // the test runner choke on any imported .tsx. Server components are imported
  // by the page-guard tests, so give them a real JSX transform here.
  oxc: {
    jsx: { runtime: "automatic" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
