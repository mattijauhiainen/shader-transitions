import { easeInOut } from "./easeInOut.ts";

export function animateTo(duration: number, fn: (t: number) => void): Promise<void> {
  return new Promise(resolve => {
    const start = performance.now();
    function frame() {
      const t = easeInOut(Math.min((performance.now() - start) / duration, 1));
      fn(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}
