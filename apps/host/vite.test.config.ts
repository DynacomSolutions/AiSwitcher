import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "host-test-entry",
    transformIndexHtml: {
      order: "pre",
      handler(html) { return html.replace('/src/main.tsx', '/src/main.test.tsx'); },
    },
  }],
  clearScreen: false,
  envPrefix: ["VITE_"],
});
