import { readdirSync } from "fs";

const server = Bun.serve({
  port: 4000,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/halftone-gl.html") {
      return new Response(Bun.file("halftone-gl.html"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (path === "/halftone-gl.ts") {
      const result = await Bun.build({
        entrypoints: ["./halftone-gl.ts"],
        target: "browser",
      });
      return new Response(await result.outputs[0].text(), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file("index.html"), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (path === "/style.css") {
      return new Response(Bun.file("style.css"), {
        headers: { "Content-Type": "text/css" },
      });
    }

    if (path === "/images") {
      const files = readdirSync("./images")
        .filter((f) => f.endsWith(".avif"))
        .sort()
        .map((f) => `/images/${f}`);
      return new Response(JSON.stringify(files), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path.startsWith("/images/")) {
      return new Response(Bun.file(`.${path}`));
    }

    if (path === "/index.ts") {
      const result = await Bun.build({
        entrypoints: ["./index.ts"],
        target: "browser",
      });
      return new Response(await result.outputs[0].text(), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Listening on http://localhost:${server.port}`);
