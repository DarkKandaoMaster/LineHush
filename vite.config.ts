import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Keep Rust compiler errors visible in `tauri dev`.
  clearScreen: false,
  // Tauri loads the fixed devUrl http://localhost:1420.
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
