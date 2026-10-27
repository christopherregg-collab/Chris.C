// Local dev server: serves the static files and runs api/*.js handlers the way
// Vercel does. Usage: npm run dev  (PORT defaults to 3000). No dependencies.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 3000;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    const api = pathname.match(/^\/api\/([\w-]+)$/);
    if (api) {
      const { default: handler } = await import(join(root, "api", `${api[1]}.js`));
      return await handler(req, res);
    }
    const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(root)) throw Object.assign(new Error("forbidden"), { code: "ENOENT" });
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    res.writeHead(err.code === "ENOENT" || err.code === "ERR_MODULE_NOT_FOUND" ? 404 : 500);
    res.end(err.code === "ENOENT" ? "Not found" : String(err));
  }
}).listen(port, () => console.log(`Dashboard on http://localhost:${port}`));
