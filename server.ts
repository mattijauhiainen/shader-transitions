import { readdirSync } from "node:fs";
import { join } from "node:path";

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

// Every explainer under ./explainers, as paths relative to that directory.
function listExplainers(dir = "explainers"): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? listExplainers(join(dir, entry.name))
        : entry.name.endsWith(".html")
          ? [join(dir, entry.name)]
          : [],
    );
}

// The explainers are plain static HTML the server already serves by path; this
// index just saves having to remember their filenames.
function explainerIndex(): string {
  const items = listExplainers()
    .map((path) => `<li><a href="/${path}">${path.slice("explainers/".length)}</a></li>`)
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8" />
<title>Explainers</title>
<h1>Explainers</h1>
<ul>
${items}
</ul>`;
}

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

    if (path === "/explainers" || path === "/explainers/") {
      return new Response(explainerIndex(), {
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
    if (contentType && (await file.exists())) {
      return new Response(file, {
        headers: { "Content-Type": contentType },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
