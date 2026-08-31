import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "dist/client",
    target: "es2022",
    // Phaser is ~1.5MB on its own; splitting it buys nothing at this stage.
    chunkSizeWarningLimit: 2000,
  },
});
