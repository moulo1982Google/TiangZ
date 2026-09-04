import { defineConfig } from "vitest/config";
import type { OxcOptions } from "vite";

const oxc = {
  decorator: { legacy: true },
  tsconfig: {
    compilerOptions: {
      experimentalDecorators: true,
      useDefineForClassFields: true,
    },
  },
} as OxcOptions & { readonly tsconfig: object };

export default defineConfig({
  oxc,
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global_setup.ts"],
    fileParallelism: true,
    pool: "forks",
    isolate: true,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["app/core/**/*.ts"],
      exclude: ["app/core/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "dist/coverage/unit",
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 75,
        lines: 72,
      },
    },
  },
});
