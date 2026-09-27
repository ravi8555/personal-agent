import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Isolated frontend — no coupling to the backend project.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Optional: point /api at the Personal-Agent backend if it ever runs
    // locally. Leave commented so the UI stays fully standalone.
    // proxy: { "/api": "http://localhost:3000" }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});