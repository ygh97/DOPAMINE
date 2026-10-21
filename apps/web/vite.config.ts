import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const API = process.env.API_ORIGIN ?? "http://127.0.0.1:4810";

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, host: "127.0.0.1", proxy: { "/api": { target: API, changeOrigin: true } } },
  preview: { port: 4173, host: "127.0.0.1", proxy: { "/api": { target: API, changeOrigin: true } } },
});
