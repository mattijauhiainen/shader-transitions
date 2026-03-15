import { readdirSync, mkdirSync, cpSync } from "fs";

const OUT = "./dist";

mkdirSync(`${OUT}/images`, { recursive: true });

// Build HTML + JS + CSS bundle
const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: OUT,
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

// Copy images
cpSync("./images", `${OUT}/images`, { recursive: true });

// Generate image list
const images = readdirSync("./images")
  .filter((f) => f.endsWith(".avif"))
  .sort()
  .map((f) => `/images/${f}`);
await Bun.write(`${OUT}/images.json`, JSON.stringify(images));

console.log(`Built ${result.outputs.length} bundle(s), ${images.length} images`);
