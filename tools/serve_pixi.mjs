import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "pixi_client");
const port = Number(process.argv[2] ?? 7460);
const types = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".map", "application/json"]]);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("invalid path");
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": types.get(path.extname(file)) ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`TiangZ Pixi client: http://127.0.0.1:${port}`);
});
