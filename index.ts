import { loadImage } from "./loadImage.ts";
import { sleep } from "./sleep.ts";
import { animateTo } from "./animateTo.ts";
import { Renderer } from "./renderer.ts";

const DURATION = 1500;
const PAUSE = 0;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const gl = canvas.getContext("webgl2")!;

try {
  const renderer = new Renderer(gl, canvas.width, canvas.height);

  async function runSlideshow(paths: string[]) {
    const firstImg = await loadImage(paths[0]);
    renderer.prepareNext(firstImg);
    renderer.swap();
    renderer.renderTransition(0);

    for (let i = 0; ; i = (i + 1) % paths.length) {
      const nextImgPromise = loadImage(paths[(i + 1) % paths.length]);

      await sleep(PAUSE);

      const nextImg = await nextImgPromise;
      renderer.prepareNext(nextImg);
      renderer.randomizeOrigin();

      await animateTo(DURATION, t => renderer.renderTransition(t));

      renderer.swap();
    }
  }

  const paths: string[] = await fetch("/images").then(r => r.json());
  runSlideshow(paths);
} catch (e) {
  document.body.style.cssText = "color:red;padding:2em;font-family:monospace;white-space:pre-wrap";
  document.body.textContent = String(e);
  throw e;
}
