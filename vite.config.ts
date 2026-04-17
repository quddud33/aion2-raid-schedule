import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages: 저장소 이름 기준 서브경로. 로컬은 '/'
const base = process.env.VITE_BASE?.trim() || "/";

export default defineConfig({
  plugins: [react()],
  base: base.endsWith("/") ? base : `${base}/`,
});
