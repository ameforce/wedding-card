import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createEarlyPosterMarkup } from "./scripts/intro/early-poster.mjs";

function pastelIntroEarlyPoster() {
  let command = "serve";
  let markup;
  const bootContents = readFileSync(new URL("./src/intro/early-cover-boot.js", import.meta.url), "utf8");
  const bootFileName = `pastel-intro-early-boot-${createHash("sha256").update(bootContents).digest("hex").slice(0, 12)}.js`;
  return {
    name: "pastel-intro-early-poster",
    configResolved(config) {
      command = config.command;
      markup = createEarlyPosterMarkup({ bootSource: command === "serve" ? "/src/intro/early-cover-boot.js" : `/assets/${bootFileName}` });
    },
    buildStart() {
      if (command !== "build") return;
      this.emitFile({
        type: "asset",
        fileName: `assets/${bootFileName}`,
        source: bootContents,
      });
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
