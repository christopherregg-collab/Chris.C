/// <reference types="vitest/config" />
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Runs api/*.js the way Vercel does, so `npm run dev` serves /api/candles too.
function vercelApi(): Plugin {
  return {
    name: "vercel-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/([\w-]+)(?:\?|$)/);
        if (!match) return next();
        const file = resolve(__dirname, "api", `${match[1]}.js`);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(req, res);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), vercelApi()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        markets: resolve(__dirname, "markets.html"),
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
