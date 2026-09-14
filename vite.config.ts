import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/client", import.meta.url)),
    },
  },
  build: {
    outDir: "dist/assets",
    assetsDir: "assets",
    manifest: true,
    sourcemap: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        diff: fileURLToPath(new URL("./src/client/diff.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "diff" ? "assets/diff-[hash].js" : "assets/app-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/app-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "assets/diff-[hash].js",
      },
    },
  },
});
