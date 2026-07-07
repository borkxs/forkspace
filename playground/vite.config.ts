import { defineConfig } from "vite";
import path from "node:path";

/** Project pages URL: https://borkxs.github.io/forkspace/ */
const pagesBase = "/forkspace/";

export default defineConfig({
  root: path.resolve(__dirname),
  base: process.env.GITHUB_PAGES ? pagesBase : "./",
  resolve: {
    alias: {
      "@forkspace": path.resolve(__dirname, "../src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: false,
  },
});
