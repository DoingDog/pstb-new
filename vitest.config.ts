import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const resolve = {
  alias: {
    "@": new URL("./src/client", import.meta.url).pathname,
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.jsonc",
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["src/http.test.ts"],
        },
      },
      {
        resolve,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/http.test.ts", "src/**/*.browser.test.tsx"],
        },
      },
      {
        resolve,
        server: {
          host: "127.0.0.1",
        },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
