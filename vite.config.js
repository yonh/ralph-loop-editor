import { defineConfig } from "vite";

/**
 * Vite configuration for Tauri desktop development and production builds.
 */
export default defineConfig({
  clearScreen: false,
  server: {
    host: "0.0.0.0",
    port: 1420,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["es2021", "chrome105", "safari13"],
  },
});
