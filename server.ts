import { readdirSync } from "fs";

// Generate images.json for dev
const images = readdirSync("./images")
  .filter((f) => f.endsWith(".avif"))
  .sort()
  .map((f) => `/images/${f}`);
await Bun.write("./images.json", JSON.stringify(images));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const server = Bun.serve({
  port: 4000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file("index.html"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (path === "/index.ts") {
      const result = await Bun.build({
        entrypoints: ["./index.ts"],
        target: "browser",
      });
      return new Response(await result.outputs[0]!.text(), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    const ext = path.substring(path.lastIndexOf("."));
    const contentType = CONTENT_TYPES[ext];
    const file = Bun.file(`.${path}`);
    if (contentType && await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": contentType },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
