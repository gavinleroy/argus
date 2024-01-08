import fs from "fs";
import { defineConfig } from "vite";
import { resolve } from "path";

let manifest = JSON.parse(fs.readFileSync("package.json", "utf-8"));
export default defineConfig(({ mode }) => ({
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      name: "Extension",
      formats: ["iife"],
    },
    rollupOptions: {
      external: Object.keys(manifest.dependencies || {})
    }
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  test: {
    environment: "jsdom",
    deps: {
      inline: [/^(?!.*vitest).*$/],
    },
  },
}));
