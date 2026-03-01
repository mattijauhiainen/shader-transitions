import { loadImage } from "./loadImage.ts";
import { sleep } from "./sleep.ts";
import { animateTo } from "./animateTo.ts";
import { Renderer } from "./renderer.ts";

const DURATION = 2500;
const PAUSE = 1000;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

const gl = canvas.getContext("webgl2")!;

try {
  const renderer = new Renderer(gl, canvas.width, canvas.height);
  const transitions = renderer.transitions;

  async function runSlideshow(paths: string[]) {
    shuffle(paths);

    const firstImg = await loadImage(paths[0]);
    renderer.prepareNext(firstImg);
    renderer.swap();
    transitions[0].prepareRender()(0);

    let ti = 0;
    const shuffledTransitions = shuffle([...transitions]);

    for (let i = 0; ; i = (i + 1) % paths.length) {
      const nextImgPromise = loadImage(paths[(i + 1) % paths.length]);

      await sleep(PAUSE);

      const nextImg = await nextImgPromise;
      renderer.prepareNext(nextImg);

      const render = shuffledTransitions[ti].prepareRender();
      ti = (ti + 1) % shuffledTransitions.length;
      await animateTo(DURATION, render);

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

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
