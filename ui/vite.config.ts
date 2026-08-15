import { defineConfig } from "vite";

// `process` below is a Node global, so this workspace needs @types/node of its
// own. It resolved from the repo root during development and only failed in CI,
// where nothing installs the root — the same shape of bug as the `mktemp`
// spelling that the checks workflow was widened for.

/**
 * Built output is served by `claude-local-telemetry api --ui <dir>`, from the
 * same origin as /api.
 *
 * `base` is absolute, not relative. The app has deep routes (/sessions/:id),
 * and a relative base would make the asset URLs in index.html resolve against
 * /sessions/ on a refresh — every script 404s and the page renders blank.
 *
 * In dev, Vite proxies /api to the running API rather than relying on its CORS
 * header, so the request path is byte-identical in both modes and a
 * same-origin bug can't hide behind a permissive dev setup.
 */
export default defineConfig({
  base: "/",
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env["TELEMETRY_API"] ?? "http://127.0.0.1:4319",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Top-level await in main.ts (the conditional polyfill) needs a target that
    // permits it.
    target: "es2022",
    sourcemap: true,
  },
});
