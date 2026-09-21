import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createEarlyPosterMarkup } from "./scripts/intro/early-poster.mjs";

function pastelIntroEarlyPoster() {
  let markup;
  return {
    name: "pastel-intro-early-poster",
    configResolved() {
      markup = createEarlyPosterMarkup();
    },
    transformIndexHtml(html) {
      return html
        .replace("<!-- PASTEL_INTRO_EARLY_HEAD -->", markup.styles)
        .replace("<!-- PASTEL_INTRO_EARLY_POSTER -->", markup.posterNode);
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [pastelIntroEarlyPoster(), react()],
});
