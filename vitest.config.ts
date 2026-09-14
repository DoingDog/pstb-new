import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const resolve = {
  alias: {
    "@": fileURLToPath(new URL("./src/client", import.meta.url)),
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
        optimizeDeps: {
          include: ["class-variance-authority", "cn", "lucide-react", "radix-ui", "react", "react-dom", "react-dom/client"],
        },
        plugins: [tailwindcss()],
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
