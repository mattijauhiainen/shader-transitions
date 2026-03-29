# Halftones

A fullscreen photo slideshow rendered as halftone dots using WebGL2. Photos are converted into grids of colored circles whose radii encode brightness, then animated between with a variety of GPU-driven transitions.

See the deployed site [here](https://shader-transitions.netlify.app).

## Why

Learning shader programming has been something I've tried a few times, but never got too far. After reading this [article](https://blog.maximeheckel.com/posts/shades-of-halftone/) by Maxime Heckel about shaders and halftones, I wanted to try to build my own version. I also wanted to explore self-studying a subject with Claude Code (mixed feelings on that, but it's a lot of fun).

## How it works

The renderer converts each source photo into a grid of average cell colors via a render-to-texture pass, then computes the global luma range through hierarchical parallel reduction. A final pass draws anti-aliased circles sized by brightness. Transitions take two complete sets of these textures (current and next image) and animate between them using either fullscreen-quad fragment shaders or instanced rendering, depending on whether dots need to move independently. Transition implementations live in `transitions/`.

## Getting started

Requires [Bun](https://bun.sh).

```sh
bun install
```

### Development

```sh
bun run dev
```

Starts a dev server on `http://localhost:4000` with on-the-fly bundling.

### Build

```sh
bun run build
```

Produces a static site in `dist/` -- HTML, JS, CSS, images, and an `images.json` manifest. No server-side code required.

### Deploy

```sh
bun run deploy
```

Builds and deploys to Netlify via `netlify deploy --prod`.

## Images

Drop `.avif` photos into the `images/` directory. The build script discovers them automatically and generates `images.json`. The renderer scales each image to cover the canvas (like CSS `object-fit: cover`), so any aspect ratio works.
