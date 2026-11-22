import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd via @cloudflare/vitest-plugin (the renamed
// @cloudflare/vitest-pool-workers). Bindings come from wrangler.jsonc; the
// ingest secrets are fixed made-up values so tests never depend on .dev.vars.
export const TEST_SECRETS = {
  INGEST_SECRET_TRADING: "test-trading-secret",
  INGEST_SECRET_SUMMARY: "test-summary-secret",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // ACCESS_DEV_BYPASS skips the Access JWT check, and only for local
      // hostnames (see src/access.ts). Production never sets it.
      miniflare: { bindings: { ...TEST_SECRETS, ACCESS_DEV_BYPASS: "1" } },
    }),
  ],
});
