import { defineConfig } from "vitest/config";

// Server tests run in node; app tests opt into jsdom with `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
