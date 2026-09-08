import { defineConfig } from "vite";

// Electron loads the built files over file:// in production, so asset paths must
// be relative rather than rooted at "/".
export default defineConfig({
  base: "./",

  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Settings window
        main: "index.html",
        // Always-on-top mic indicator
        overlay: "overlay.html",
        // Hidden window that owns microphone capture
        recorder: "recorder.html",
      },
    },
  },

  server: {
    port: 1420,
    strictPort: true,
  },
});
