import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works at any path (GitHub Pages serves it under /readle/).
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 3000, strictPort: true },
});
