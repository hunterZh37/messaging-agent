import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Matches the "@/*" path tsconfig gives Next.js (lib/embedClock.ts reaches
  // "@/lib/core" and "@/lib/mailClock"; vitest does not read tsconfig paths
  // on its own) (2026-10-07).
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: { include: ["test/**/*.test.ts"] },
});
