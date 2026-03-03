import { easeInOut } from "./easeInOut.ts";

export function animateTo(duration: number, fn: (t: number) => void, easing?: (t: number) => number): Promise<void> {
  const ease = easing ?? easeInOut;
  return new Promise(resolve => {
    const start = performance.now();
    function frame() {
      const t = ease(Math.min((performance.now() - start) / duration, 1));
      fn(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}
