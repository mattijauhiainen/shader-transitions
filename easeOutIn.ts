const TAU = 2 * Math.PI;
const A = 0.5;

export function easeOutIn(t: number) {
  return t + (A * Math.sin(TAU * t)) / TAU;
}
